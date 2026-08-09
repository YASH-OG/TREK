import {
  budgetCreateItemRequestSchema, type BudgetCreateItemRequest,
  budgetUpdateItemRequestSchema, type BudgetUpdateItemRequest,
  placeCreateRequestSchema, placeUpdateRequestSchema,
  dayCreateRequestSchema, dayUpdateRequestSchema,
  tripUpdateRequestSchema, tripCreateRequestSchema,
  reservationCreateRequestSchema, reservationUpdateRequestSchema,
  reservationEndpointsInputSchema,
  accommodationCreateRequestSchema, accommodationUpdateRequestSchema,
  packingCreateItemRequestSchema, packingUpdateItemRequestSchema,
  collectionCreateRequestSchema, collectionUpdateRequestSchema,
  collectionSavePlaceRequestSchema, collectionCopyToTripRequestSchema,
} from '@trek/shared';
import {
  KNOWN_METHODS,
  type KnownMethod,
  type RpcError,
  type RpcRequest,
  type RpcResponse,
} from '../protocol/envelope';
import type { PluginDataDb } from './plugin-data.service';
import { stripEmoji } from '../text-sanitize';
import { auditResource, isAuditable } from './plugin-audit';
import { BadParams, ForbiddenResource } from './rpc-errors';
import { asArgs, asPayload, asTxOps, num, str } from './rpc-params';
import type { PluginRpcRegistry } from './rpc-kit/registry';

// Both used to be declared here. They now live in rpc-errors.ts so decorated
// *.rpc.ts handlers can throw them without importing the router, and are re-exported
// so every existing importer keeps working unchanged.
export { BadParams, ForbiddenResource };

/**
 * The per-plugin capability router (#plugins, M1) — the ENFORCEMENT POINT.
 *
 * Built from the plugin's GRANTED permission set. Only the methods a permission
 * unlocks are registered; an ungranted method is simply never in the map, so the
 * plugin cannot "call it anyway" — there is no shared object, only messages, and
 * the host is the sole holder of the trek.db handle and the broadcast fns.
 *
 * Runs in the HOST (parent) process.
 */

interface CoreDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
}

export interface HostDeps {
  /** The plugin's own sqlite (db:own). */
  data: PluginDataDb;
  /** Read-only handle to the core trek.db, used ONLY through the typed readers here. */
  db: CoreDb;
  /** Returns the trip row if the user may access it, else undefined. */
  canAccessTrip(tripId: number, userId: number): unknown;
  /** True if the target user is the acting user or co-members a trip with them. */
  canSeeUser(actingUserId: number, targetUserId: number): boolean;
  /** Namespaced trip broadcast (host forces the plugin:{id}:{event} event type). */
  broadcastToTrip(tripId: number, eventType: string, payload: Record<string, unknown>): void;
  /** Namespaced per-user broadcast. */
  broadcastToUser(userId: number, payload: Record<string, unknown>): void;
  // --- Host-mediated notifications (recipient resolution + channel fan-out owned
  // by the host; the plugin supplies only target + plain text). ---
  canAccessTripForNotify(tripId: number, userId: number): boolean;
  sendPluginNotification(pluginId: string, input: { title: string; body: string; link?: string; scope: 'user' | 'trip'; targetId: number }): Promise<unknown>;
  // --- Host-mediated LLM (the host owns the credential; output is DATA the plugin
  // must still push through the gated write methods). ---
  aiConfigured(userId: number): boolean;
  aiComplete(userId: number, prompt: string, system: string | undefined): Promise<unknown>;
  aiExtract(userId: number, text: string, jsonSchema: object, prompt: string | undefined): Promise<unknown>;
  /** The acting user's own value for one of this plugin's `scope:'user'` settings (decrypted). */
  getUserSetting(pluginId: string, userId: number, key: string): unknown;
  /** A short-lived OAuth access token for the acting user (host-brokered; refreshes if
   * expiring). Null when the user hasn't connected. The plugin never sees the refresh token. */
  getOAuthToken(pluginId: string, userId: number): Promise<string | null>;
  /** Schedule (upsert by name) a userless future callback; everyMs set = recurring. Caps enforced here. */
  schedulerSet(name: string, dueAt: number, everyMs: number | undefined, payload: unknown): { scheduled: boolean };
  /** Cancel a scheduled callback by name. */
  schedulerCancel(name: string): { cancelled: boolean };
  /** Optional sink for the capability audit log (host-side, hash-chained). */
  audit?(entry: { pluginId: string; actingUserId?: number; method: string; resource: string | null; code: string }): void;
  /** Call an export on another plugin (this host's plugin is the caller). Authorizes
   * the dependency edge + the target's `provides` allowlist, forwards the acting user. */
  callPlugin(targetId: string, fn: string, args: unknown, actingUserId: number | undefined): Promise<unknown>;
  /** Publish an event from this host's plugin to its subscribed dependents. */
  emitPluginEvent(event: string, payload: unknown): void;
  /** True when the Costs (budget) addon is enabled — gates all costs.* methods. */
  /** True if the acting user may create costs on the trip (the 'budget_edit' permission). */
  /** A trip's packing items visible to `userId` (#858 private-item filter), for `packing.list`. */
  /** A trip's files (trash excluded), for `files.list`. */
  /** One trip file's bytes as base64 (size-capped), for `files.getContent`. Throws if it's not on the trip or exceeds the cap. */
  // --- Files write (the app's file_upload / file_edit / file_delete permissions) ---
  /** Store a bounded base64 payload as a trip file (extension + size validated); broadcasts file:created. */
  /** Link an existing trip file to a reservation/place/assignment on the SAME trip. */
  /** Update a file's description/links (same-trip targets enforced); broadcasts file:updated. */
  /** Move a trip file to the trash; broadcasts file:deleted. */
  // --- Collab reads (membership + collab addon; no separate right, like the REST GETs) ---
  // --- Collab content (the app's collab_edit permission; collab addon gated) ---
  // --- Member add (the DISTINCT member_manage permission — never bundled) ---
  /** The acting user's own journals (journey addon must be enabled). */
  /** The entries of one of the acting user's journeys (journey addon; access-checked). */
  /** The acting user's visited countries + regions (atlas addon must be enabled). */
  /** The acting user's bucket-list items (atlas addon must be enabled). */
  /** The acting user's vacation plan data (vacay addon must be enabled). */
  /** The acting user's saved-place collections (collections addon must be enabled). */
  /** One of the acting user's collections by id (collections addon must be enabled). */
  // --- Collections write (the service enforces per-collection role itself) ---
  // --- Atlas write (all rows are the acting user's own; atlas addon gated) ---
  // --- Vacay write (plan resolved from the acting user; vacay addon gated) ---
  // --- Journal write (journeyService.canEdit self-gates; journey addon gated) ---
  /** Create/delete a JOURNAL itself (owned by the acting user) — lets an importer
   * bootstrap the journal it then fills, and clean it up. */
  /** A trip day's notes (trip-scoped), for `daynotes.list`. */
  /** Create a day note (the day must be on the trip); broadcasts dayNote:created. */
  /** Update a day note (scoped to the day+trip); broadcasts dayNote:updated. */
  /** Delete a day note (scoped to the day+trip); broadcasts dayNote:deleted. */
  /** All budget items of one trip, hydrated with members/payers. */
  /** All budget items across every trip the acting user can access. */
  /** Create a budget item on a trip (and broadcast); returns the created item. */
  /** Update a budget item on a trip (and broadcast); returns the updated item. */
  /** Delete a budget item from a trip (and broadcast); returns { deleted: true }. */
  // --- Places (the 'place_edit' permission) ---
  /** Still needed by the db:meta gate, which has not moved yet. */
  canEditTrip(tripId: number, userId: number): boolean;
  /** Also still needed by the db:meta gate. */
  canEditReservations(tripId: number, userId: number): boolean;
  canEditPlaces(tripId: number, userId: number): boolean;
  // --- Days + itinerary (the 'day_edit' permission) ---
  canEditDays(tripId: number, userId: number): boolean;
  /** Assign a place to a day (both trip-scoped by the wiring); returns the assignment. */
  /** Remove a day-assignment (trip-scoped by the wiring). */
  // --- Trip (the 'trip_edit' permission) ---
  // --- Trip creation (the 'trip_create' permission; owner = acting user) ---
  // --- Exchange rates (tenant-free, like weather) ---
  // --- Cross-trip reads (membership baked in — every trip the acting user can access) ---
  /** Every trip the acting user owns or is a member of (the listTrips baseline). */
  /** Every reservation across the acting user's accessible trips. */
  /** A trip's days with their assignments + day notes — the planner GET's shape. */
  /** A trip's reservations, hydrated like the REST list (endpoints, day_positions, joins). */
  /** A trip's lodging blocks (day_accommodations) with the joined place fields. */
  // --- Accommodations write (the 'day_edit' permission, like the accommodations REST path) ---
  /** Create a lodging block (auto-creates its partner hotel reservation + broadcasts); returns it. */
  /** Update a lodging block (syncs the partner reservation); throws if it isn't on the trip. */
  /** Delete a lodging block (cascades the partner reservation/budget row); returns { deleted: true }. */
  // --- Reservations (the 'reservation_edit' permission) ---
  /** Create a reservation (accommodation/budget side effects + broadcasts, as the web app); returns it. */
  /** Update a reservation on a trip (same side effects); returns it, or throws if it isn't on the trip. */
  /** Delete a reservation from a trip (same side effects); returns { deleted: true }. */
  // --- Packing (the 'packing_edit' permission; #858 privacy-scoped broadcasts) ---
  /** Create a packing item (owner = acting user); privacy-scoped packing:created broadcast; returns it. */
  /** Update a packing item; four-case public<->private broadcast; throws if not on the trip. */
  /** Delete a packing item; owner+recipients-scoped packing:deleted broadcast; returns { deleted: true }. */
  // --- Packing bags (packing_edit; no privacy — broadcast to the whole room) ---
  // --- Read-convenience: weather (tenant-free), categories (global), the trip roster ---
  // --- Tags (the acting user's own; no trip) ---
  // --- Todos (core, trip-scoped; the 'packing_edit' permission, like the REST path) ---
  // --- Plugin metadata on core entities (db:meta) ---
  /** The trip a trip/place/day belongs to (for the membership gate), or undefined. */
  metaEntityTrip(entityType: string, entityId: number): number | undefined;
  metaGet(entityType: string, entityId: number, key: string): unknown;
  metaSet(entityType: string, entityId: number, key: string, value: unknown): unknown;
  metaList(entityType: string, entityId: number): unknown;
  metaDelete(entityType: string, entityId: number, key: string): unknown;
}

type Handler = (params: Record<string, unknown>, actingUserId: number | undefined) => unknown;

// Mirrors the STRING_LIMITS the places REST controller enforces (the @trek/shared
// schema doesn't), so the plugin write path rejects the same oversized fields.
const PLACE_STR_LIMITS: Record<string, number> = { name: 200, description: 2000, address: 500, notes: 2000 };
// Core entities a plugin may attach its own db:meta to. Each maps to an owning
// trip (metaEntityTrip) so the membership + edit gates are the standard ones.
const META_ENTITY_TYPES: ReadonlySet<string> = new Set(['trip', 'place', 'day', 'reservation', 'accommodation']);
// Same idea for trips — the @trek/shared schema leaves the title/description open,
// so mirror the REST controller's field limits on the plugin write path too.
const TRIP_STR_LIMITS: Record<string, number> = { title: 200, description: 2000 };

export class PluginRpcHost {
  private methods = new Map<string, Handler>();

  constructor(
    private readonly pluginId: string,
    granted: ReadonlySet<string>,
    private readonly deps: HostDeps,
    // Additive and OPTIONAL, the same convention plugin-runtime.service.ts already
    // uses for its own late-added params. Every existing
    // `new PluginRpcHost(id, granted, deps)` site keeps compiling untouched, which is
    // what makes the decorator rollout a per-domain move instead of a big-bang one.
    registry?: PluginRpcRegistry,
  ) {
    const has = (p: string) => granted.has(p);

    if (has('db:own')) {
      this.methods.set('db.query', (p) => deps.data.query(str(p.sql, 'sql'), asArgs(p.args)));
      this.methods.set('db.exec', (p) => deps.data.exec(str(p.sql, 'sql'), asArgs(p.args)));
      this.methods.set('db.migrate', (p) => deps.data.migrate(str(p.id, 'id'), str(p.sql, 'sql')));
      this.methods.set('db.tx', (p) => deps.data.tx(asTxOps(p.ops)));
    }

    // trips.*, reservations.listMine and the member roster now live in
    // src/nest/trips/trips.rpc.ts.
    // files.* now lives in src/nest/files/files.rpc.ts.

    // User-scoped addon reads: the acting user's OWN journals/atlas/vacay across all
    // their trips (not one trip), so — like costs.listMine — they are gated on a bound
    // acting user, not a tripId; the wiring additionally refuses a disabled addon.
    // collab, journal, atlas, vacay and collections now live in their own
    // domains' *.rpc.ts, each carrying its addon gate with it.

    // costs.* now lives in src/nest/budget/costs.rpc.ts.


    // --- Core planner writes (#1429). Each mirrors costs.create: validate the
    // input against the SAME @trek/shared schema the web app uses, then gate on
    // trip access + the entity's edit permission for the HOST-bound acting user
    // (a job/onLoad has no user, so its writes are refused). The delegating deps
    // reuse the real services + broadcast the same events, so the app stays live. ---
    // places.* now lives in src/nest/places/places.rpc.ts.

    // days.* now lives in src/nest/days/days.rpc.ts.

    // itinerary.* now lives in src/nest/assignments/itinerary.rpc.ts.



    // rates.get now lives in src/nest/budget/exchange-rates.rpc.ts.

    // daynotes.* now live in src/nest/days/day-notes.rpc.ts.

    // reservations.* now lives in src/nest/reservations/reservations.rpc.ts.

    // accommodations.* now lives in src/nest/days/accommodations.rpc.ts.

    // packing.* now lives in src/nest/packing/packing.rpc.ts.

    // weather.get and categories.list now live in their own domains' *.rpc.ts.
    // tags.* now lives in src/nest/tags/tags.rpc.ts, bound through the registry below.
    // todos.* now live in src/nest/todo/todo.rpc.ts.

    if (has('db:meta')) {
      // A plugin's OWN namespaced key/value store attached to a core entity. Not
      // core data — but the entity must belong to a trip the acting user can
      // ACCESS, so a plugin can't stash/read metadata against another tenant's rows.
      this.methods.set('meta.get', (p, uid) => { const e = this.metaEntity(p, uid, false); return deps.metaGet(e.entityType, e.entityId, str(p.key, 'key')); });
      this.methods.set('meta.set', (p, uid) => { const e = this.metaEntity(p, uid, true); return deps.metaSet(e.entityType, e.entityId, str(p.key, 'key'), p.value); });
      this.methods.set('meta.list', (p, uid) => { const e = this.metaEntity(p, uid, false); return deps.metaList(e.entityType, e.entityId); });
      this.methods.set('meta.delete', (p, uid) => { const e = this.metaEntity(p, uid, true); return deps.metaDelete(e.entityType, e.entityId, str(p.key, 'key')); });
    }

    if (has('db:read:users')) {
      // Scope to people the acting user can actually see (self or a trip they
      // share) so a plugin can't enumerate every account's profile by looping ids.
      this.methods.set('users.getById', (p, uid) => {
        const id = num(p.id, 'id');
        if (uid === undefined) throw new ForbiddenResource('user reads require an authenticated user context');
        if (id !== uid && !this.deps.canSeeUser(uid, id)) throw new ForbiddenResource(`no access to user ${id}`);
        return deps.db.prepare('SELECT id, username, display_name, avatar FROM users WHERE id = ?').get(id);
      });
    }

    if (has('ws:broadcast:trip')) {
      // Gate the TARGET the same way reads are gated: a plugin may only push to a
      // trip room the acting user is a member of — never an arbitrary/other-tenant
      // trip. (Event-type namespacing alone doesn't cross the membership boundary.)
      this.methods.set('ws.broadcastToTrip', (p, uid) => {
        const tripId = num(p.tripId, 'tripId');
        if (uid === undefined) throw new ForbiddenResource('broadcasts require an authenticated user context');
        if (!this.deps.canAccessTrip(tripId, uid)) throw new ForbiddenResource(`no access to trip ${tripId}`);
        deps.broadcastToTrip(tripId, str(p.event, 'event'), asPayload(p.data));
        return { ok: true };
      });
    }
    if (has('ws:broadcast:user')) {
      // Restrict to the acting user's own connections — a plugin may not push to
      // an arbitrary user it has no relationship to.
      this.methods.set('ws.broadcastToUser', (p, uid) => {
        const userId = num(p.userId, 'userId');
        if (uid === undefined || userId !== uid) {
          throw new ForbiddenResource('a plugin may only broadcast to the acting user');
        }
        deps.broadcastToUser(userId, { event: str(p.event, 'event'), ...asPayload(p.data) });
        return { ok: true };
      });
    }

    if (has('notify:send')) {
      // Host-mediated notification. The plugin supplies only plain text + a target;
      // the host owns recipient resolution, channel fan-out and per-user preferences.
      // Recipients are FORCED to the acting user (scope 'user', targetId===uid) or a
      // trip the acting user is a member of (scope 'trip'); scope 'admin' is refused,
      // so there is no arbitrary-recipient / admin-broadcast path (no spam, no phishing).
      this.methods.set('notify.send', (p, uid) => {
        const actor = this.requireActor(uid, 'notification');
        const input = asPayload(p.input);
        // Emoji-stripped so a bell/push notification matches TREK's lucide-only UI (also
        // trims + collapses whitespace). An all-emoji title collapses to '' → rejected.
        const title = typeof input.title === 'string' ? stripEmoji(input.title) : '';
        const body = typeof input.body === 'string' ? stripEmoji(input.body) : '';
        if (!title || title.length > 200) throw new BadParams('notification title is required (max 200 chars)');
        if (!body || body.length > 1000) throw new BadParams('notification body is required (max 1000 chars)');
        const scope = input.scope;
        if (scope !== 'user' && scope !== 'trip') throw new BadParams("scope must be 'user' or 'trip'");
        const targetId = num(input.targetId, 'targetId');
        if (scope === 'user' && targetId !== actor) throw new ForbiddenResource('a plugin may only notify the acting user');
        if (scope === 'trip' && !deps.canAccessTripForNotify(targetId, actor)) throw new ForbiddenResource('the acting user is not a member of that trip');
        let link: string | undefined;
        if (typeof input.link === 'string' && input.link !== '') {
          // In-app path only. A bare startsWith check misses `/\evil.com`, `/<tab>/…`
          // etc. that browsers normalize to protocol-relative, so resolve against a
          // throwaway origin and require the result to stay on it (same rule as the
          // proxy's toRelativeLocation).
          let safe: string | null = null;
          try {
            const u = new URL(input.link, 'http://x.invalid');
            if (u.origin === 'http://x.invalid') safe = (u.pathname + u.search + u.hash);
          } catch { /* invalid → rejected below */ }
          if (!safe) throw new BadParams('link must be an in-app path starting with /');
          link = safe.slice(0, 512);
        }
        return deps.sendPluginNotification(this.pluginId, { title, body, link, scope, targetId });
      });
    }
    if (has('ai:invoke')) {
      // Host-mediated LLM. The host holds the (encrypted) credential and runs the
      // call under the acting user's resolved provider config; the plugin passes only
      // a prompt / JSON-schema. Output is returned as DATA — never auto-written — so
      // prompt-injection cannot reach a write without the plugin's own gated call.
      this.methods.set('ai.complete', (p, uid) => {
        const actor = this.requireActor(uid, 'AI');
        if (!deps.aiConfigured(actor)) throw new BadParams('no AI provider is configured for this user');
        const prompt = typeof p.prompt === 'string' ? p.prompt : '';
        if (prompt.trim() === '') throw new BadParams('prompt is required');
        if (prompt.length > 20000) throw new BadParams('prompt exceeds the 20000-char cap');
        return deps.aiComplete(actor, prompt, typeof p.system === 'string' ? p.system.slice(0, 4000) : undefined);
      });
      this.methods.set('ai.extract', (p, uid) => {
        const actor = this.requireActor(uid, 'AI');
        if (!deps.aiConfigured(actor)) throw new BadParams('no AI provider is configured for this user');
        const text = typeof p.text === 'string' ? p.text : '';
        if (text.trim() === '') throw new BadParams('text is required');
        if (text.length > 20000) throw new BadParams('text exceeds the 20000-char cap');
        if (typeof p.jsonSchema !== 'object' || p.jsonSchema === null) throw new BadParams('jsonSchema (an object) is required');
        return deps.aiExtract(actor, text, p.jsonSchema as object, typeof p.prompt === 'string' ? p.prompt.slice(0, 4000) : undefined);
      });
    }
    if (has('oauth:client')) {
      // Host-brokered outbound OAuth: return a short-lived access token for the acting
      // user (the host ran the flow + holds the refresh token). Never yields a token for
      // a userless context, and the plugin can never reach the refresh token/secret.
      this.methods.set('oauth.getToken', async (_p, uid) => {
        // Userless context (a job/scheduled task) → null, matching the SDK contract + mock
        // ("null when the user hasn't connected or in a userless context"), rather than
        // throwing RESOURCE_FORBIDDEN, which a background caller can't meaningfully handle.
        if (uid === undefined) return { accessToken: null };
        return { accessToken: await deps.getOAuthToken(this.pluginId, uid) };
      });
    }

    if (has('jobs:run')) {
      // Persistent scheduler: a plugin schedules a userless future callback (once or
      // recurring) that survives restarts. Same grant + risk class as its cron jobs.
      // Caps are enforced in the wiring (max entries, name/payload size, min interval).
      this.methods.set('scheduler.set', (p) => {
        const name = str(p.name, 'name');
        const dueAt = num(p.dueAt, 'dueAt');
        const everyMs = p.everyMs != null ? num(p.everyMs, 'everyMs') : undefined;
        return deps.schedulerSet(name, dueAt, everyMs, p.payload ?? null);
      });
      this.methods.set('scheduler.cancel', (p) => deps.schedulerCancel(str(p.name, 'name')));
    }

    // Inter-plugin capabilities (#plugins deps). Registered UNCONDITIONALLY — there
    // is no permission for these; the router authorizes each call against the
    // declared dependency edge + the target's `provides`/`emits` allowlist. The
    // acting user is forwarded so the target's export runs as the caller's user.
    this.methods.set('plugins.call', (p, uid) =>
      deps.callPlugin(str(p.targetId, 'targetId'), str(p.fn, 'fn'), p.args, uid),
    );
    this.methods.set('events.emit', (p) => {
      deps.emitPluginEvent(str(p.event, 'event'), p.payload);
      return { ok: true };
    });
    // The plugin's OWN per-user settings (the acting user's `scope:'user'` values,
    // decrypted host-side). Unconditional + not sensitive cross-tenant — it only ever
    // returns THIS plugin's config for the acting user. A userless context (job/onLoad)
    // has no user, so it returns undefined (the plugin falls back to ctx.config).
    this.methods.set('settings.get', (p, uid) => {
      if (uid === undefined) return { value: undefined };
      return { value: deps.getUserSetting(this.pluginId, uid, str(p.key, 'key')) };
    });

    // LAST on purpose: a method still owned by one of the has() blocks above then
    // collides loudly in bindInto instead of being silently overridden, which is the
    // failure mode a half-finished domain move would otherwise have.
    //
    // `deps.data` is already the lazy per-access getter the factory supplies, so
    // passing it through a getter here preserves the disable/re-enable semantics
    // exactly and the kit never needs to know about plugin-host-state.
    registry?.bindInto(this.methods, granted, (actingUserId) => ({
      pluginId,
      actingUserId,
      get data() {
        return deps.data;
      },
    }));
  }

  /**
   * Membership-check every trip read against the acting user. The acting user is
   * bound by the HOST from the authenticated invocation (see the supervisor's
   * invocation map) — NOT taken from a plugin-supplied `asUserId`, which a plugin
   * could set to any id to read another user's trips. If no acting user is bound
   * (a job / onLoad, or a forged call), the read is forbidden.
   */
  private tripRead(p: Record<string, unknown>, actingUserId: number | undefined, read: (userId: number) => unknown): unknown {
    const tripId = num(p.tripId, 'tripId');
    if (actingUserId === undefined) {
      throw new ForbiddenResource('trip reads require an authenticated user context');
    }
    if (!this.deps.canAccessTrip(tripId, actingUserId)) {
      throw new ForbiddenResource(`no access to trip ${tripId}`);
    }
    // The read runs only for a bound, membership-checked user — hand it through so
    // per-user visibility filters (e.g. packing's #858 private items) can apply.
    return read(actingUserId);
  }

  /**
   * Every write needs a HOST-bound acting user. A job / onLoad (no user) or a call
   * with a forged/unknown invocation id resolves to undefined and is refused — a
   * plugin can never write "as" an arbitrary user.
   */
  private requireActor(uid: number | undefined, noun: string): number {
    if (uid === undefined) throw new ForbiddenResource(`${noun} writes require an authenticated user context`);
    return uid;
  }

  /**
   * The @trek/shared write schemas don't carry the string-length caps the REST
   * controllers add, so mirror those caps here — otherwise a plugin could write a
   * field the web app would reject with 400 (e.g. a 100k-char place name).
   */
  private capStrings(input: Record<string, unknown>, limits: Record<string, number>): void {
    for (const [field, max] of Object.entries(limits)) {
      const v = input[field];
      if (typeof v === 'string' && v.length > max) throw new BadParams(`${field} must be ${max} characters or fewer`);
    }
  }

  /** A write is allowed only if the acting user can access AND edit the trip. */
  private requireTripEdit(tripId: number, uid: number, canEdit: (t: number, u: number) => boolean): void {
    if (!this.deps.canAccessTrip(tripId, uid)) throw new ForbiddenResource(`no access to trip ${tripId}`);
    if (!canEdit(tripId, uid)) throw new ForbiddenResource(`no permission to edit trip ${tripId}`);
  }

  /**
   * Validate a metadata target and gate it: the entity type must be one we support,
   * and the trip it belongs to must be accessible to the host-bound acting user.
   */
  private metaEntity(p: Record<string, unknown>, uid: number | undefined, write: boolean): { entityType: string; entityId: number } {
    const entityType = str(p.entityType, 'entityType');
    if (!META_ENTITY_TYPES.has(entityType)) {
      throw new BadParams(`invalid entityType "${entityType}" (${[...META_ENTITY_TYPES].join('|')})`);
    }
    const entityId = num(p.entityId, 'entityId');
    if (uid === undefined) throw new ForbiddenResource('metadata requires an authenticated user context');
    const tripId = this.deps.metaEntityTrip(entityType, entityId);
    if (tripId === undefined || !this.deps.canAccessTrip(tripId, uid)) {
      throw new ForbiddenResource(`no access to ${entityType} ${entityId}`);
    }
    // Reads need trip access; WRITES additionally need the entity's edit permission
    // — so a read-only member can't overwrite/delete metadata an editor created
    // (matches how core writes are gated). Accommodations ride on day_edit (like
    // the accommodation write path), reservations on reservation_edit.
    if (write) {
      const canEdit = entityType === 'trip' ? this.deps.canEditTrip
        : entityType === 'place' ? this.deps.canEditPlaces
        : entityType === 'reservation' ? this.deps.canEditReservations
        : this.deps.canEditDays; // day + accommodation
      if (!canEdit(tripId, uid)) throw new ForbiddenResource(`no permission to edit ${entityType} ${entityId}`);
    }
    return { entityType, entityId };
  }

  async dispatch(req: RpcRequest, actingUserId?: number): Promise<RpcResponse | RpcError> {
    const raw = (req.params ?? {}) as Record<string, unknown>;
    // The supervisor resolves the acting user from `_inv` BEFORE dispatch and passes
    // the request on untouched, so `_inv` is visible to every handler today and is in
    // effect a reserved param name. Strip it here: no handler and no audit reads
    // anything but named fields, and dropping it keeps a future strict schema parse
    // from rejecting calls every shipped plugin makes.
    const { _inv, ...stripped } = raw;
    const params = '_inv' in raw ? stripped : raw;
    const res = await this.handle(req, params, actingUserId);
    // Audit the core-data / broadcast surface (incl. denials) at the boundary.
    if (this.deps.audit && isAuditable(req.method)) {
      try {
        this.deps.audit({
          pluginId: this.pluginId,
          actingUserId,
          method: req.method,
          resource: auditResource(req.method, params),
          code: res.ok ? 'ok' : (res as RpcError).error.code,
        });
      } catch {
        /* auditing must never break a call */
      }
    }
    return res;
  }

  private async handle(
    req: RpcRequest,
    params: Record<string, unknown>,
    actingUserId?: number,
  ): Promise<RpcResponse | RpcError> {
    const handler = this.methods.get(req.method);
    if (!handler) {
      const known = (KNOWN_METHODS as readonly string[]).includes(req.method as KnownMethod);
      return this.err(
        req.id,
        known ? 'PERMISSION_DENIED' : 'UNKNOWN_METHOD',
        known
          ? `${req.method} requires a permission "${this.pluginId}" was not granted`
          : `unknown method ${req.method}`,
      );
    }
    try {
      const result = await handler(params, actingUserId);
      return { k: 'res', id: req.id, ok: true, result };
    } catch (e) {
      if (e instanceof BadParams) return this.err(req.id, 'BAD_PARAMS', e.message);
      if (e instanceof ForbiddenResource) return this.err(req.id, 'RESOURCE_FORBIDDEN', e.message);
      return this.err(req.id, 'HOST_ERROR', e instanceof Error ? e.message : 'internal error');
    }
  }

  private err(id: string, code: RpcError['error']['code'], message: string): RpcError {
    return { k: 'res', id, ok: false, error: { code, message } };
  }

  /** Release host-held resources (the plugin's own db handle) on terminal stop. */
  dispose(): void {
    try {
      this.deps.data.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * The reservation body is passthrough by contract, but a malformed `endpoints`
 * array would otherwise fail DEEP in the service (NOT-NULL mid-transaction) or be
 * dropped silently (missing coords) — both miserable to debug from a plugin. So
 * the plugin path pins the endpoint shape up front; absent stays absent
 * (update semantics: omitted = keep, [] = delete all).
 */
function requireValidEndpoints(v: unknown): void {
  if (v === undefined) return;
  const parsed = reservationEndpointsInputSchema.safeParse(v);
  if (!parsed.success) throw new BadParams(`invalid endpoints: ${parsed.error.issues[0]?.message ?? 'bad input'}`);
}
