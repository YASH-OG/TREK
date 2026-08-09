/**
 * The capability router is the plugin permission boundary (#plugins, M1). These
 * tests prove that an ungranted method is never reachable, a granted method
 * works, a granted trip read is still membership-checked against the acting
 * user, and bad params / unknown methods are rejected — without ever spawning a
 * child (the router runs in the host).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../../src/db/schema';
import { PluginRpcHost, type HostDeps } from '../../../src/nest/plugins/host/rpc-host';
import type { RpcRequest, RpcResponse, RpcError } from '../../../src/nest/plugins/protocol/envelope';
import { makeDeps } from '../../helpers/rpc-host-deps';


const req = (method: string, params: Record<string, unknown> = {}): RpcRequest => ({ k: 'req', id: 'x', method, params });
const ok = (r: RpcResponse | RpcError): r is RpcResponse => r.ok === true;

describe('PluginRpcHost — capability enforcement', () => {
  let deps: HostDeps;
  beforeEach(() => { deps = makeDeps(); });

  it('registers only granted methods; an ungranted method is PERMISSION_DENIED', async () => {
    const host = new PluginRpcHost('p', new Set(['db:own']), deps);
    const denied = await host.dispatch(req('trips.getById', { tripId: 1, asUserId: 42 }));
    expect(denied.ok).toBe(false);
    expect((denied as RpcError).error.code).toBe('PERMISSION_DENIED');
    expect(deps.canAccessTrip).not.toHaveBeenCalled();
  });

  it('a granted db:own method runs against the plugin db', async () => {
    const host = new PluginRpcHost('p', new Set(['db:own']), deps);
    const res = await host.dispatch(req('db.query', { sql: 'SELECT 1', args: [] }));
    expect(ok(res)).toBe(true);
    expect((res as RpcResponse).result).toEqual([{ n: 1 }]);
    expect(deps.data.query).toHaveBeenCalledWith('SELECT 1', []);
  });

  it('an unknown method is UNKNOWN_METHOD, not PERMISSION_DENIED', async () => {
    const host = new PluginRpcHost('p', new Set(['db:own']), deps);
    const res = await host.dispatch(req('fs.readFile', { path: '/etc/passwd' }));
    expect((res as RpcError).error.code).toBe('UNKNOWN_METHOD');
  });

  // The trips, roster and member cases moved to tests/unit/trips/trips.rpc.test.ts.
  it('db:read:users returns only the public projection for a visible user', async () => {
    const host = new PluginRpcHost('p', new Set(['db:read:users']), deps);
    const res = await host.dispatch(req('users.getById', { id: 3 }), 42);
    expect(ok(res)).toBe(true);
    expect((res as RpcResponse).result).toEqual({ id: 3, username: 'ada', display_name: 'Ada', avatar: null });
    // the SELECT column list is host-controlled — no password/token columns
    expect(deps.db.prepare).toHaveBeenCalledWith(expect.stringContaining('id, username, display_name, avatar'));
  });

  it('db:read:users is RESOURCE_FORBIDDEN for a user the acting user cannot see (no enumeration)', async () => {
    const host = new PluginRpcHost('p', new Set(['db:read:users']), deps);
    const forbidden = await host.dispatch(req('users.getById', { id: 999 }), 42);
    expect((forbidden as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
    // and with no bound acting user (job / forged call), also denied
    const noUser = await host.dispatch(req('users.getById', { id: 3 }), undefined);
    expect((noUser as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
  });

  it('ws:broadcast:trip forwards to the (namespaced) broadcaster for a member', async () => {
    const host = new PluginRpcHost('p', new Set(['ws:broadcast:trip']), deps);
    const res = await host.dispatch(req('ws.broadcastToTrip', { tripId: 1, event: 'ping', data: { a: 1 } }), 42);
    expect(ok(res)).toBe(true);
    expect(deps.broadcastToTrip).toHaveBeenCalledWith(1, 'ping', { a: 1 });
  });

  it('ws:broadcast:trip is RESOURCE_FORBIDDEN for a non-member trip (no cross-tenant push)', async () => {
    const host = new PluginRpcHost('p', new Set(['ws:broadcast:trip']), deps);
    const forbidden = await host.dispatch(req('ws.broadcastToTrip', { tripId: 999, event: 'x', data: {} }), 42);
    expect((forbidden as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
    expect(deps.broadcastToTrip).not.toHaveBeenCalled();
    // and a broadcast with no bound acting user is denied too
    const noUser = await host.dispatch(req('ws.broadcastToTrip', { tripId: 1, event: 'x', data: {} }), undefined);
    expect((noUser as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
  });

  it('bad params are BAD_PARAMS', async () => {
    const host = new PluginRpcHost('p', new Set(['db:own']), deps);
    const res = await host.dispatch(req('db.query', { args: [] }));
    expect((res as RpcError).error.code).toBe('BAD_PARAMS');
  });

  it('with no permissions, every real method is denied', async () => {
    const host = new PluginRpcHost('p', new Set<string>(), deps);
    for (const m of ['db.query', 'trips.getById', 'users.getById', 'ws.broadcastToTrip']) {
      const res = await host.dispatch(req(m, { tripId: 1, asUserId: 42, id: 3, event: 'x', sql: 'SELECT 1' }));
      expect((res as RpcError).error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('ws:broadcast:user forwards only to the acting user (never an arbitrary one)', async () => {
    const host = new PluginRpcHost('p', new Set(['ws:broadcast:user']), deps);
    const res = await host.dispatch(req('ws.broadcastToUser', { userId: 42, event: 'poke', data: { x: 2 } }), 42);
    expect(ok(res)).toBe(true);
    expect(deps.broadcastToUser).toHaveBeenCalledWith(42, { event: 'poke', x: 2 });
    // broadcasting to a DIFFERENT user is refused
    const forbidden = await host.dispatch(req('ws.broadcastToUser', { userId: 9, event: 'poke', data: {} }), 42);
    expect((forbidden as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
  });

  it('non-array db args are BAD_PARAMS; a primitive ws payload is wrapped', async () => {
    const host = new PluginRpcHost('p', new Set(['db:own', 'ws:broadcast:trip']), deps);
    const bad = await host.dispatch(req('db.query', { sql: 'SELECT 1', args: 'nope' }));
    expect((bad as RpcError).error.code).toBe('BAD_PARAMS');

    await host.dispatch(req('ws.broadcastToTrip', { tripId: 1, event: 'ping', data: 'primitive' }), 42);
    expect(deps.broadcastToTrip).toHaveBeenCalledWith(1, 'ping', { value: 'primitive' });
  });

  it('dispose() closes the plugin data db', () => {
    const host = new PluginRpcHost('p', new Set(['db:own']), deps);
    host.dispose();
    expect(deps.data.close).toHaveBeenCalled();
  });

  // The costs, reservation and accommodation cases moved to their domain suites.
  // The addon-gated domains moved to their own suites; addon-gates.rpc.test.ts
  // covers every gate in one table.
  // The daynotes cases moved to tests/unit/days/day-notes.rpc.test.ts.

  // weather.get, categories.list and rates.get moved to tests/unit/plugins/tenant-free.rpc.test.ts.

  // The tags cases moved to tests/unit/tags/tags.rpc.test.ts with the handlers.

  // The files cases moved to tests/unit/files/files.rpc.test.ts with the handlers.
  it('notify.send forces the recipient to the acting user or a member trip; admin scope refused', async () => {
    const host = new PluginRpcHost('p', new Set(['notify:send']), deps);
    expect(ok(await host.dispatch(req('notify.send', { input: { title: 'Delay', body: 'AB123 is late', scope: 'user', targetId: 42 } }), 42))).toBe(true);
    expect(deps.sendPluginNotification).toHaveBeenCalledWith('p', expect.objectContaining({ scope: 'user', targetId: 42 }));
    expect(ok(await host.dispatch(req('notify.send', { input: { title: 'Trip', body: 'x', scope: 'trip', targetId: 1 } }), 42))).toBe(true);
    // another user (scope user, foreign targetId) → forbidden
    expect(((await host.dispatch(req('notify.send', { input: { title: 't', body: 'b', scope: 'user', targetId: 99 } }), 42)) as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
    // a trip the acting user isn't in → forbidden
    expect(((await host.dispatch(req('notify.send', { input: { title: 't', body: 'b', scope: 'trip', targetId: 2 } }), 42)) as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
    // admin scope → bad params (not an allowed scope)
    expect((await host.dispatch(req('notify.send', { input: { title: 't', body: 'b', scope: 'admin', targetId: 0 } }), 42)).ok).toBe(false);
    // a protocol-relative / absolute link → rejected
    expect((await host.dispatch(req('notify.send', { input: { title: 't', body: 'b', scope: 'user', targetId: 42, link: '//evil.com' } }), 42)).ok).toBe(false);
    expect((await host.dispatch(req('notify.send', { input: { title: '', body: 'b', scope: 'user', targetId: 42 } }), 42)).ok).toBe(false);
  });

  it('ai.complete/extract require a configured provider + a bound user, with caps', async () => {
    const host = new PluginRpcHost('p', new Set(['ai:invoke']), deps);
    expect(ok(await host.dispatch(req('ai.complete', { prompt: 'Summarize my trip' }), 42))).toBe(true);
    expect(ok(await host.dispatch(req('ai.extract', { text: 'AB123 JFK 10:00', jsonSchema: { type: 'object' } }), 42))).toBe(true);
    expect((await host.dispatch(req('ai.complete', { prompt: '' }), 42)).ok).toBe(false);
    expect((await host.dispatch(req('ai.extract', { text: 'x', jsonSchema: 'not-an-object' }), 42)).ok).toBe(false);
    expect((await host.dispatch(req('ai.complete', { prompt: 'x'.repeat(20001) }), 42)).ok).toBe(false);
    // user 7 has no provider configured → bad params (not a crash)
    expect((await host.dispatch(req('ai.complete', { prompt: 'hi' }), 7)).ok).toBe(false);
    // no user context at all → forbidden
    expect((await host.dispatch(req('ai.complete', { prompt: 'hi' }), undefined)).ok).toBe(false);
  });

  it('settings.get returns the acting user\'s own value; a userless context yields undefined', async () => {
    // No permission required — it only ever returns THIS plugin's config for the acting user.
    const host = new PluginRpcHost('p', new Set(), deps);
    const bound = await host.dispatch(req('settings.get', { key: 'apiKey' }), 42);
    expect(ok(bound)).toBe(true);
    expect((bound as RpcResponse).result).toEqual({ value: 'secret-of-p' });
    expect(deps.getUserSetting).toHaveBeenCalledWith('p', 42, 'apiKey');
    const userless = await host.dispatch(req('settings.get', { key: 'apiKey' }), undefined);
    expect((userless as RpcResponse).result).toEqual({ value: undefined });
  });

  it('oauth.getToken needs the grant + a bound user; returns only the access token', async () => {
    const host = new PluginRpcHost('p', new Set(['oauth:client']), deps);
    const ok1 = await host.dispatch(req('oauth.getToken', {}), 42);
    expect(ok(ok1)).toBe(true);
    expect((ok1 as RpcResponse).result).toEqual({ accessToken: 'access-token-xyz' });
    expect(deps.getOAuthToken).toHaveBeenCalledWith('p', 42);
    // no bound user (a job/onLoad) → null, matching the SDK contract, not an error
    const userless = await host.dispatch(req('oauth.getToken', {}), undefined);
    expect(ok(userless)).toBe(true);
    expect((userless as RpcResponse).result).toEqual({ accessToken: null });
    // without the grant → not reachable
    const noGrant = new PluginRpcHost('p', new Set(), deps);
    expect((await noGrant.dispatch(req('oauth.getToken', {}), 42)).ok).toBe(false);
  });

  it('scheduler.set/cancel ride on jobs:run and are userless (no acting user needed)', async () => {
    const host = new PluginRpcHost('p', new Set(['jobs:run']), deps);
    // userless (no bound user) is fine — scheduled tasks are like jobs
    const set = await host.dispatch(req('scheduler.set', { name: 'poll', dueAt: 123, everyMs: 60000, payload: { x: 1 } }), undefined);
    expect(ok(set)).toBe(true);
    expect(deps.schedulerSet).toHaveBeenCalledWith('poll', 123, 60000, { x: 1 });
    const cancel = await host.dispatch(req('scheduler.cancel', { name: 'poll' }), undefined);
    expect(ok(cancel)).toBe(true);
    // without jobs:run → not reachable
    const noGrant = new PluginRpcHost('p', new Set(), deps);
    expect((await noGrant.dispatch(req('scheduler.set', { name: 'x', dueAt: 1 }), 42) as RpcError).error.code).toBe('PERMISSION_DENIED');
  });

  it('a read scope is denied without its own permission', async () => {
    const host = new PluginRpcHost('p', new Set(['db:read:trips']), deps);
    expect((await host.dispatch(req('journal.listMine'), 42)).ok).toBe(false);
    expect((await host.dispatch(req('daynotes.list', { tripId: 1, dayId: 5 }), 42)).ok).toBe(false);
  });

  it('an error thrown by a handler becomes HOST_ERROR', async () => {
    (deps.data.query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk gone');
    });
    const host = new PluginRpcHost('p', new Set(['db:own']), deps);
    const res = await host.dispatch(req('db.query', { sql: 'SELECT 1', args: [] }));
    expect((res as RpcError).error.code).toBe('HOST_ERROR');
    expect((res as RpcError).error.message).toBe('disk gone');
  });

  it('a non-Error thrown by a handler still maps to HOST_ERROR', async () => {
    (deps.data.query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw 'raw string';
    });
    const host = new PluginRpcHost('p', new Set(['db:own']), deps);
    const res = await host.dispatch(req('db.query', { sql: 'SELECT 1' }));
    expect((res as RpcError).error.code).toBe('HOST_ERROR');
    expect((res as RpcError).error.message).toBe('internal error');
  });

  // ── Costs (budget items): db:read:costs / db:write:costs ────────────────────

  // --- Planner writes (#1429) ---
  // The places, days and itinerary cases moved to their own domain suites.
  it('places.create is PERMISSION_DENIED without db:write:places', async () => {
    const host = new PluginRpcHost('p', new Set(['db:read:trips']), deps);
    const res = await host.dispatch(req('places.create', { tripId: 1, input: { name: 'X' } }), 42);
    expect((res as RpcError).error.code).toBe('PERMISSION_DENIED');
  });

  // --- Plugin metadata (db:meta) ---
  it('db:meta stores and reads namespaced metadata on an accessible entity', async () => {
    const host = new PluginRpcHost('p', new Set(['db:meta']), deps);
    const set = await host.dispatch(req('meta.set', { entityType: 'trip', entityId: 1, key: 'rating', value: 5 }), 42);
    expect(ok(set)).toBe(true);
    expect(deps.metaSet).toHaveBeenCalledWith('trip', 1, 'rating', 5);
    const placeOk = await host.dispatch(req('meta.get', { entityType: 'place', entityId: 7, key: 'x' }), 42);
    expect(ok(placeOk)).toBe(true); // place 7 resolves to accessible trip 1
  });

  it('meta.set is PERMISSION_DENIED without db:meta', async () => {
    const host = new PluginRpcHost('p', new Set(['db:read:trips']), deps);
    const res = await host.dispatch(req('meta.set', { entityType: 'trip', entityId: 1, key: 'x', value: 1 }), 42);
    expect((res as RpcError).error.code).toBe('PERMISSION_DENIED');
  });

  it('meta is RESOURCE_FORBIDDEN on an entity the acting user cannot access', async () => {
    const host = new PluginRpcHost('p', new Set(['db:meta']), deps);
    const res = await host.dispatch(req('meta.set', { entityType: 'trip', entityId: 2, key: 'x', value: 1 }), 42);
    expect((res as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
    expect(deps.metaSet).not.toHaveBeenCalled();
  });

  it('meta with an unknown entityType is BAD_PARAMS', async () => {
    const host = new PluginRpcHost('p', new Set(['db:meta']), deps);
    const res = await host.dispatch(req('meta.set', { entityType: 'user', entityId: 1, key: 'x', value: 1 }), 42);
    expect((res as RpcError).error.code).toBe('BAD_PARAMS');
  });

  it('meta writes resolve the entity edit permission per type (place→place_edit, day→day_edit) and refuse no-user', async () => {
    const host = new PluginRpcHost('p', new Set(['db:meta']), deps);
    expect(ok(await host.dispatch(req('meta.set', { entityType: 'place', entityId: 7, key: 'k', value: 1 }), 42))).toBe(true);
    expect(deps.canEditPlaces).toHaveBeenCalled();
    expect(ok(await host.dispatch(req('meta.set', { entityType: 'day', entityId: 3, key: 'k', value: 1 }), 42))).toBe(true);
    expect(deps.canEditDays).toHaveBeenCalled();
    // reservation metadata uses reservation_edit; accommodation uses day_edit
    expect(ok(await host.dispatch(req('meta.set', { entityType: 'reservation', entityId: 40, key: 'ext_id', value: 'AB1' }), 42))).toBe(true);
    expect(deps.canEditReservations).toHaveBeenCalled();
    expect(ok(await host.dispatch(req('meta.set', { entityType: 'accommodation', entityId: 11, key: 'k', value: 1 }), 42))).toBe(true);
    // an entity of another trip is refused
    expect((await host.dispatch(req('meta.get', { entityType: 'reservation', entityId: 999, key: 'k' }), 42) as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
    // no host-bound acting user (a job / forged call) → refused
    const noUser = await host.dispatch(req('meta.get', { entityType: 'trip', entityId: 1, key: 'k' }), undefined);
    expect((noUser as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
  });

  // Regression (#getPlaces): the mocked `db.prepare` above never parses the SQL, so an
  // invalid column sails through. Drive the trip reads against a REAL schema-loaded
  // SQLite instead — `places` has no day_id/position (those live on day_assignments),
  // so the old `ORDER BY day_id, position` threw `no such column` on every call.
  it('meta WRITES need the entity edit permission — a read-only member is RESOURCE_FORBIDDEN', async () => {
    // Member can access the trip but not edit it (viewer role).
    (deps.canEditTrip as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const host = new PluginRpcHost('p', new Set(['db:meta']), deps);
    const write = await host.dispatch(req('meta.set', { entityType: 'trip', entityId: 1, key: 'x', value: 1 }), 42);
    expect((write as RpcError).error.code).toBe('RESOURCE_FORBIDDEN');
    expect(deps.metaSet).not.toHaveBeenCalled();
    // …but a READ is only access-gated, so it still works.
    const read = await host.dispatch(req('meta.get', { entityType: 'trip', entityId: 1, key: 'x' }), 42);
    expect(ok(read)).toBe(true);
    expect(deps.metaGet).toHaveBeenCalled();
  });
});
