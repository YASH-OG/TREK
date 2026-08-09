import { Injectable } from '@nestjs/common';
import { readEnv } from '../../../app-config';
import { RealtimeService } from '../../realtime/realtime.service';
import { BLOCKED_EXTENSIONS, filesDir } from '../../files/files.constants';
import { TripMembershipService } from '../../trip-membership/trip-membership.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { createLlmClient } from '../../llm-parse/llm-client.factory';
import { readUserSettingDecrypted } from '../plugins.service';
import { PluginOAuthService } from '../plugin-oauth.service';
import fsMod from 'node:fs';
import pathMod from 'node:path';
import { randomUUID } from 'node:crypto';
import { PermissionsService } from '../../permissions/permissions.service';
import { TripsService, NotFoundError, ValidationError } from '../../trips/trips.service';
import { PlacesService, type PlaceCreateInput, type PlaceUpdateInput } from '../../places/places.service';
import { AddonsService } from '../../addons/addons.service';
import { isDemoEmail } from '../../common/demo';
import { ADDON_IDS } from '../../../addons';
import { JourneyDomainService } from '../../journey/journey-domain.service';
import { AtlasService } from '../../atlas/atlas.service';
import { CollectionsService } from '../../collections/collections.service';
import { BudgetService } from '../../budget/budget.service';
import { ExchangeRatesService } from '../../budget/exchange-rates.service';
import { ReservationsService } from '../../reservations/reservations.service';
import { TagsService } from '../../tags/tags.service';
import { CategoriesService } from '../../categories/categories.service';
import { TodoService } from '../../todo/todo.service';
import { PackingService } from '../../packing/packing.service';
import { DayNotesService } from '../../days/day-notes.service';
import { DaysService } from '../../days/days.service';
import { AssignmentsService } from '../../assignments/assignments.service';
import { LlmConfigResolver } from '../../llm-parse/llm-config.resolver';
import { DatabaseService } from '../../database/database.service';
import { FilesService } from '../../files/files.service';
import { CollabService } from '../../collab/collab.service';
import { VacayService } from '../../vacay/vacay.service';
import { PluginRpcHost, ForbiddenResource, BadParams } from './rpc-host';
import { PluginRpcRegistryService } from './rpc-kit/registry.service';
import { appendAudit } from './plugin-audit';
import { getPluginDataDb, budgetFor } from './plugin-host-state';

// collectionsService self-gates per-collection role by THROWING status-tagged errors
// (assertAccess 404, assertCanEdit 403, validation 400). Map them onto the RPC error
// classes so a plugin sees RESOURCE_FORBIDDEN / BAD_PARAMS instead of HOST_ERROR.
function mapCollectionError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const status = (e as { status?: number })?.status;
    const msg = e instanceof Error ? e.message : 'collection error';
    if (status === 403 || status === 404) throw new ForbiddenResource(msg);
    if (status === 400 || status === 409) throw new BadParams(msg);
    throw e;
  }
}

// Journey mirroring is best-effort on every other path that triggers it
// (places.service wraps the same hooks, assignments.service wraps the reconcile),
// so a broken journey link can never turn a successful write into an RPC error.
function mirrorJourneys(run: () => void): void {
  try { run(); } catch { /* non-fatal */ }
}

// The #858 privacy-scoped packing broadcasts used to be copied here, with a comment
// asking for the copy to be kept in lockstep with packing.controller.ts and
// packing.service.ts by hand. They now live once, in PackingService, and both the
// REST controller and PackingRpc call them there.

// Quotas for plugin entity metadata (db:meta) — a cheap disk-DoS guard on the
// shared trek.db volume. Generous for real use, small enough to bound abuse.
const META_VALUE_MAX = 64 * 1024; // serialized JSON bytes per value
const META_KEY_MAX = 256; // key string length (the key is attacker-controlled too)
const META_KEYS_MAX = 100; // keys per (plugin, entity)

/** Routes inter-plugin calls/events; supplied by PluginRuntimeService (owns the supervisor). */
export interface PluginCallRouter {
  callPlugin(callerId: string, targetId: string, fn: string, args: unknown, actingUserId: number | undefined): Promise<unknown>;
  emitPluginEvent(sourceId: string, event: string, payload: unknown): void;
}

/**
 * Wires a plugin's capability host to the REAL privileged modules (#plugins,
 * M1). This is the ONLY plugin file that touches the realtime broadcast facade
 * — it runs in the host (parent), never in the child. Broadcasts are
 * force-namespaced to `plugin:{id}:{event}` so a plugin can't forge a core event.
 *
 * DI-native domain services (budget, exchange-rates, reservations, tags,
 * categories, todo, packing, day-notes, assignments, oauth, files, collab,
 * vacay, trips, places, collections, atlas, notifications, the LLM config
 * resolver) and the DatabaseService (all inline SQL + the trip-access helper) are
 * constructor-injected; legacy `services/*` domains stay plain function
 * imports until their own migration lands (DI-MIGRATION.md), at which point
 * each swaps one import for one injected service.
 */
@Injectable()
export class PluginHostDepsFactory {
  constructor(
    private readonly budget: BudgetService,
    private readonly reservations: ReservationsService,
    private readonly tags: TagsService,
    private readonly categories: CategoriesService,
    private readonly todos: TodoService,
    private readonly packing: PackingService,
    private readonly oauth: PluginOAuthService,
    private readonly dayNotes: DayNotesService,
    private readonly assignments: AssignmentsService,
    private readonly llmConfig: LlmConfigResolver,
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly collab: CollabService,
    private readonly vacay: VacayService,
    private readonly days: DaysService,
    private readonly permissions: PermissionsService,
    private readonly exchangeRates: ExchangeRatesService,
    private readonly addons: AddonsService,
    private readonly realtime: RealtimeService,
    private readonly trips: TripsService,
    private readonly places: PlacesService,
    private readonly collections: CollectionsService,
    private readonly atlas: AtlasService,
    private readonly notifications: NotificationsService,
    private readonly membership: TripMembershipService,
    private readonly journey: JourneyDomainService,
    // Appended last and OPTIONAL so the hand-wired 26-arg construction in
    // plugin-host-deps.factory.test.ts keeps compiling. Handed to every host it
    // builds, which is how decorated *.rpc.ts handlers reach the dispatch map.
    private readonly rpcRegistry?: PluginRpcRegistryService,
  ) {}

  /**
   * The trip-access + role gate used by every planner write, mirroring the app's
   * per-domain `canEdit` (canAccessTrip + checkPermission for the entity's *_edit
   * action). Returns false — never throws — so the caller maps it to a clean
   * RESOURCE_FORBIDDEN.
   */
  private canEditTripAs(action: string, tripId: number, userId: number): boolean {
    const trip = this.db.canAccessTrip(tripId, userId);
    if (!trip) return false;
    const u = this.db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined;
    if (!u) return false;
    return this.permissions.checkPermission(action, u.role ?? 'user', trip.user_id, userId, trip.user_id !== userId);
  }

  // The booking notification the REST controller sends after a create/update/delete
  // is fire-and-forget, so it never blocks the plugin write.
  private notifyBooking(actingUserId: number, tripId: number, booking: string, type: string): void {
    this.reservations.notifyBookingChange(tripId, actingUserId, booking, type);
  }

  create(id: string, granted: ReadonlySet<string>, router: PluginCallRouter): PluginRpcHost {
    // A subsystem read is refused when its addon is off — parity with the app, where a
    // disabled addon means there is simply nothing to read (same shape as the Costs gate).
    const requireAddon = (addonId: string, noun: string): void => {
      if (!this.addons.isAddonEnabled(addonId)) throw new ForbiddenResource(`the ${noun} addon is disabled`);
    };
    return new PluginRpcHost(id, granted, {
      // Resolve the data handle lazily on every access rather than capturing it once.
      // disable()/uninstall() drop the entry from `running` BEFORE awaiting the kill grace
      // and calling dispose(), so a re-enable in that window builds a NEW host. A captured
      // handle would let the OLD host's dispose() close the DB out from under the NEW one
      // (every db.* call then throws 'database connection is not open'). Resolving per call
      // means the new host always uses the current, open handle — getPluginDataDb recreates
      // one the moment a stale dispose closes it. Safe because db.* is synchronous, so no
      // call is ever mid-flight when a dispose from another tick closes the handle.
      get data() { return getPluginDataDb(id); },
      db: this.db.connection,
      canAccessTrip: (tripId, userId) => this.db.canAccessTrip(tripId, userId),
      // The router binds this host's plugin id as the caller/source.
      callPlugin: (targetId, fn, args, actingUserId) => router.callPlugin(id, targetId, fn, args, actingUserId),
      emitPluginEvent: (event, payload) => router.emitPluginEvent(id, event, payload),
      // Two users "share a trip" when both are owner-or-member of the same trip.
      canSeeUser: (actingUserId, targetUserId) =>
        !!this.db
          .prepare(
            `SELECT 1 FROM trips t
               LEFT JOIN trip_members m1 ON m1.trip_id = t.id AND m1.user_id = ?
               LEFT JOIN trip_members m2 ON m2.trip_id = t.id AND m2.user_id = ?
              WHERE (t.user_id = ? OR m1.user_id IS NOT NULL)
                AND (t.user_id = ? OR m2.user_id IS NOT NULL)
              LIMIT 1`,
          )
          .get(actingUserId, targetUserId, actingUserId, targetUserId),
      broadcastToTrip: (tripId, event, payload) => this.realtime.broadcast(tripId, `plugin:${id}:${event}`, payload),
      broadcastToUser: (userId, payload) => this.realtime.broadcastToUser(userId, { type: `plugin:${id}`, ...payload }),
      audit: (entry) => appendAudit(this.db.connection, entry),
      // --- Costs (budget items) ---
      // Same gate as a REST/MCP budget mutation: the acting user must have trip
      // access AND the 'budget_edit' permission for their global role.
      // --- Read scopes (packing/files). Membership is checked by the host (tripRead);
      // these just delegate to the same services the REST paths use. ---
      // A file's bytes as base64, size-capped BEFORE the read so a 500MB video can't
      // be pulled (~667MB base64) through the IPC pipe. 10MB matches the plugin upload
      // cap; trashed files (deleted_at set) are refused like the download path.
      // --- Files write. Bytes arrive as bounded base64; the extension is validated
      // against the central blocklist BEFORE anything touches disk, and link targets
      // must live on the same trip (findForeignLinkTarget). Same events as the app. ---
      // --- Collab reads (collab addon; membership checked by the host). Same hydrated
      // shapes as the REST GETs, so a collab plugin can finally read what it writes. ---
      // --- Collab content (collab addon). The services validate + self-report errors. ---
      // --- Member add (member_manage). Grants trip access — the target must exist;
      // the acting user is recorded as the inviter. Owner/duplicate adds are no-ops. ---
      // --- Host-mediated notifications. Recipient resolution + channel fan-out +
      // per-user preferences are all owned by NotificationsService.send; the plugin
      // supplies only the target (host-scoped by the router) + plain text. actorId is
      // null (no user sender), so the message body carries the plugin's content. ---
      canAccessTripForNotify: (tripId, userId) => !!this.db.canAccessTrip(tripId, userId),
      sendPluginNotification: async (_pluginId, input) => {
        if (!budgetFor(id).take('notify', Date.now())) throw new BadParams('daily notification budget exhausted (resets at UTC midnight)');
        await this.notifications.send({
          event: 'plugin_notification',
          actorId: null,
          params: { title: input.title, body: input.body, ...(input.link ? { link: input.link } : {}) },
          scope: input.scope,
          targetId: input.targetId,
          inApp: input.link ? { navigateTarget: input.link } : undefined,
        });
        return { sent: true };
      },
      // --- Host-mediated LLM. The host holds the credential (LlmConfigResolver, encrypted
      // apiKey) and runs the call under the acting user's provider config; caps + the
      // provider-availability check live at the router. Reuses the extraction client:
      // complete() wraps it with a {text} schema; extract() passes the plugin's schema. ---
      aiConfigured: (userId) => this.llmConfig.resolve(userId) !== null,
      aiComplete: async (userId, prompt, system) => {
        const config = this.llmConfig.resolve(userId);
        if (!config) throw new BadParams('no AI provider is configured for this user');
        if (!budgetFor(id).take('ai', Date.now())) throw new BadParams('daily AI budget exhausted (resets at UTC midnight)');
        const results = await createLlmClient(config).extract({
          prompt: system || 'You are a helpful assistant. Reply with a JSON object of the form {"text": "..."} whose "text" field holds your answer.',
          jsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey, text: prompt,
        });
        const first = results[0] as { text?: unknown } | undefined;
        return { text: typeof first?.text === 'string' ? first.text : '' };
      },
      aiExtract: async (userId, text, jsonSchema, prompt) => {
        const config = this.llmConfig.resolve(userId);
        if (!config) throw new BadParams('no AI provider is configured for this user');
        if (!budgetFor(id).take('ai', Date.now())) throw new BadParams('daily AI budget exhausted (resets at UTC midnight)');
        const results = await createLlmClient(config).extract({
          prompt: prompt || 'Extract structured data from the text into the given JSON schema.',
          jsonSchema, model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey, text,
        });
        return { results };
      },
      // The acting user's own decrypted value for one of this plugin's user-scope settings.
      getUserSetting: (pluginId, userId, key) => readUserSettingDecrypted(pluginId, userId, key),
      // A short-lived OAuth access token for the acting user (host-brokered; refreshes).
      getOAuthToken: (pluginId, userId) => this.oauth.getAccessToken(pluginId, userId, Date.now()),
      // Persistent scheduler (jobs:run). Caps bound the abuse surface: a plugin can't
      // hoard timers, name-bomb, ship a huge payload, or busy-loop a recurring task.
      schedulerSet: (name, dueAt, everyMs, payload) => {
        const SCHED_MAX = 100;               // entries per plugin
        const NAME_MAX = 128;
        const PAYLOAD_MAX = 8 * 1024;        // 8 KB JSON
        const EVERY_MIN = 60_000;            // 1 min floor for recurring
        const DUE_MAX = Date.now() + 366 * 24 * 60 * 60 * 1000; // <= ~1 year out
        if (!name || name.length > NAME_MAX) throw new BadParams(`scheduler name is required (max ${NAME_MAX} chars)`);
        if (!Number.isFinite(dueAt) || dueAt > DUE_MAX) throw new BadParams('scheduler dueAt out of range');
        if (everyMs !== undefined && (!Number.isFinite(everyMs) || everyMs < EVERY_MIN)) throw new BadParams(`recurring interval must be >= ${EVERY_MIN} ms`);
        const json = JSON.stringify(payload ?? null);
        if (json.length > PAYLOAD_MAX) throw new BadParams(`scheduler payload too large (max ${PAYLOAD_MAX} bytes)`);
        const existing = this.db.prepare('SELECT id FROM plugin_scheduled_tasks WHERE plugin_id = ? AND name = ?').get(id, name) as { id: number } | undefined;
        if (!existing) {
          const n = (this.db.prepare('SELECT COUNT(*) AS c FROM plugin_scheduled_tasks WHERE plugin_id = ?').get(id) as { c: number }).c;
          if (n >= SCHED_MAX) throw new BadParams(`too many scheduled tasks (max ${SCHED_MAX})`);
        }
        // Upsert by (plugin, name): re-scheduling the same name replaces it.
        this.db.prepare(
          `INSERT INTO plugin_scheduled_tasks (plugin_id, name, due_at, payload, every_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (plugin_id, name) DO UPDATE SET due_at = excluded.due_at, payload = excluded.payload, every_ms = excluded.every_ms`,
        ).run(id, name, Math.max(dueAt, Date.now()), json, everyMs ?? null);
        return { scheduled: true };
      },
      schedulerCancel: (name) => {
        const r = this.db.prepare('DELETE FROM plugin_scheduled_tasks WHERE plugin_id = ? AND name = ?').run(id, name);
        return { cancelled: r.changes > 0 };
      },
      // Cross-trip: every accessible trip's budget items (membership predicate is
      // baked into listTrips). Reuses the hydrated list so members/payers come too.
      // Reuses BudgetService.create (frozen FX + members/payers), then broadcasts
      // the same 'budget:created' event the controller emits so the web app updates
      // live. No X-Socket-Id — a plugin has no originating socket.
      // Reuses BudgetService.update (re-frozen FX on a currency change), then
      // broadcasts the same 'budget:updated' event the REST controller emits. A
      // missing item is a clean RESOURCE_FORBIDDEN (parity with updatePlace).
      // Reuses BudgetService.remove, then broadcasts 'budget:deleted' with the
      // numeric id — same payload the REST controller sends.
      // --- Places (place_edit). Delegate to the same PlacesService the REST/MCP paths
      // use, then broadcast the same events so open web sessions update live, and run
      // the journey hooks places.controller runs on the same three writes: a journey
      // linked to the trip carries a skeleton entry per day-assigned place, and
      // without the hooks it keeps the old title/location — or a dead entry — until
      // somebody reloads it. ---
      // Consumed by the db:meta gate; the trip writes themselves have moved.
      canEditTrip: (tripId, userId) => this.canEditTripAs('trip_edit', tripId, userId),
      canEditReservations: (tripId, userId) => this.canEditTripAs('reservation_edit', tripId, userId),
      canEditPlaces: (tripId, userId) => this.canEditTripAs('place_edit', tripId, userId),
      // --- Days (day_edit). getDay scopes the row to the trip before any write. ---
      canEditDays: (tripId, userId) => this.canEditTripAs('day_edit', tripId, userId),
      // --- Itinerary (day_edit). Both the day AND the place must belong to the trip,
      // so a plugin can't cross-link another trip's rows (AssignmentsService doesn't
      // self-check this — the controllers do, so we reproduce it here). ---
      // --- Trip creation (trip_create; owner = acting user). No broadcast — a new trip
      // is only visible to its owner, who refetches (same as the REST POST). ---
      // --- Exchange rates: the same cached upstream feed the budget uses (tenant-free). ---
      // --- Trip (trip_edit). Only the schema-writable fields reach updateTrip; its
      // NotFound/Validation errors are mapped to clean RPC codes. ---
      // --- Cross-trip reads. The membership predicate is baked into listTrips, so a
      // plugin only ever sees the acting user's own trips/reservations (no raw
      // cross-tenant SELECT). Reuses the same hydrated services as the REST paths. ---
      // --- Trip-scoped hydrated reads (membership already checked by tripRead). Same
      // services as the REST GETs, so plugins see the exact planner shapes. ---
      // --- Accommodations (lodging blocks, day_edit). Delegates to DaysService so the
      // partner hotel reservation, the metadata sync and the delete cascade behave
      // exactly like the accommodations REST controller, cascade broadcasts included. ---
      // --- User-scoped addon reads (the acting user's own data across all trips). Each
      // reuses the same service the addon's REST/MCP path uses; the addon-enabled gate
      // mirrors the app (a disabled addon has nothing to read). ---
      // --- Collections write. The service self-gates per-collection role (assertAccess/
      // assertCanEdit throw status-tagged errors) — map those to the RPC error codes. ---
      // --- Atlas write: plain uid-scoped rows, no broadcasts in the service. ---
      // --- Vacay write: the plan is the ACTING USER's active plan (resolved host-side);
      // the service broadcasts to plan users itself. ---
      // --- Journal write: journeyService.canEdit self-gates each call (owner/contributor). ---
      // Day notes are core (no addon) and trip-scoped; membership is enforced by the host.
      // --- Day notes write (day_edit). The day must belong to the trip; broadcasts the
      // same dayNote:* events the REST controller emits so open sessions update live. ---
      // --- Reservations (bookings, reservation_edit). Delegates to ReservationsService
      // so the accommodation/budget-sync/notification/broadcast side effects match the
      // web app EXACTLY. socketId is undefined — a plugin has no originating socket. ---
      // --- Plugin metadata (db:meta). A per-plugin namespaced key/value store keyed
      // to a core entity; the plugin only ever sees rows tagged with its own id. ---
      metaEntityTrip: (entityType, entityId) => {
        if (entityType === 'trip') {
          return (this.db.prepare('SELECT id FROM trips WHERE id = ?').get(entityId) as { id: number } | undefined)?.id;
        }
        // Each of these tables has a NOT NULL trip_id, so the metadata gate resolves to
        // the owning trip and reuses the standard canAccessTrip / *_edit checks.
        const table = entityType === 'place' ? 'places'
          : entityType === 'day' ? 'days'
          : entityType === 'reservation' ? 'reservations'
          : 'day_accommodations'; // accommodation
        return (this.db.prepare(`SELECT trip_id FROM ${table} WHERE id = ?`).get(entityId) as { trip_id: number } | undefined)?.trip_id;
      },
      metaGet: (entityType, entityId, key) => {
        const row = this.db.prepare('SELECT value FROM plugin_entity_metadata WHERE plugin_id=? AND entity_type=? AND entity_id=? AND key=?')
          .get(id, entityType, entityId, key) as { value: string } | undefined;
        if (!row) return null;
        try { return JSON.parse(row.value); } catch { return null; }
      },
      metaSet: (entityType, entityId, key, value) => {
        if (key.length > META_KEY_MAX) throw new BadParams(`metadata key too long (>${META_KEY_MAX} chars)`);
        const json = JSON.stringify(value ?? null);
        if (json.length > META_VALUE_MAX) throw new BadParams(`metadata value too large (>${META_VALUE_MAX} bytes)`);
        const exists = this.db.prepare('SELECT 1 FROM plugin_entity_metadata WHERE plugin_id=? AND entity_type=? AND entity_id=? AND key=?')
          .get(id, entityType, entityId, key);
        if (!exists) {
          const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM plugin_entity_metadata WHERE plugin_id=? AND entity_type=? AND entity_id=?')
            .get(id, entityType, entityId) as { n: number };
          if (n >= META_KEYS_MAX) throw new BadParams(`too many metadata keys on this ${entityType} (max ${META_KEYS_MAX})`);
        }
        this.db.prepare(`INSERT INTO plugin_entity_metadata (plugin_id, entity_type, entity_id, key, value, updated_at)
                    VALUES (?, ?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(plugin_id, entity_type, entity_id, key)
                    DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(id, entityType, entityId, key, json);
        return { key, value: value ?? null };
      },
      metaList: (entityType, entityId) => {
        const list = this.db.prepare('SELECT key, value FROM plugin_entity_metadata WHERE plugin_id=? AND entity_type=? AND entity_id=? ORDER BY key')
          .all(id, entityType, entityId) as Array<{ key: string; value: string }>;
        const out: Record<string, unknown> = {};
        for (const r of list) { try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = null; } }
        return out;
      },
      metaDelete: (entityType, entityId, key) => {
        const res = this.db.prepare('DELETE FROM plugin_entity_metadata WHERE plugin_id=? AND entity_type=? AND entity_id=? AND key=?')
          .run(id, entityType, entityId, key);
        return { deleted: res.changes > 0 };
      },
    }, this.rpcRegistry);
  }
}
