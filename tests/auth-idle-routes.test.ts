import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AuthMetadata, SessionData } from '../lib/auth/types';
import type { RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external';
import type { WorkStore } from 'next/dist/server/app-render/work-async-storage.external';

let directory: string;
let store: typeof import('../lib/auth/store');
let registry: typeof import('../lib/auth/session-registry').sessionRegistry;
let mutex: typeof import('../lib/auth/mutex');
let vault: typeof import('../lib/storage/vault');
let database: typeof import('../lib/storage/database');
let guards: typeof import('../lib/auth/guards');
let workStorage: typeof import('next/dist/server/app-render/work-async-storage.external');
let requestStorage: typeof import('next/dist/server/app-render/work-unit-async-storage.external');
let cookies: typeof import('next/dist/server/web/spec-extension/cookies');
let iron: typeof import('iron-session');
let loginRoute: typeof import('../app/api/auth/login/route');
let logoutRoute: typeof import('../app/api/auth/logout/route');
let statusRoute: typeof import('../app/api/auth/status/route');
let activityRoute: typeof import('../app/api/auth/activity/route');
let settingsRoute: typeof import('../app/api/admin/session-settings/route');
let settings: typeof import('../lib/auth/security-settings');
let fixture: AuthMetadata;
const secret = 'synthetic-idle-route-session-secret-longer-than-32';
const password = 'synthetic-primary-password';

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'travel-idle-routes-'));
  Object.assign(process.env, { DATA_DIR: directory, AUTH_FILE: join(directory, 'auth.json'), DATABASE_URL: `file:${join(directory, 'data.db')}`, UPLOADS_DIR: join(directory, 'uploads'), SESSION_SECRET: secret, APP_PASSWORD: '' });
  Object.assign(globalThis, { AsyncLocalStorage });
  store = await import('../lib/auth/store');
  registry = (await import('../lib/auth/session-registry')).sessionRegistry;
  mutex = await import('../lib/auth/mutex');
  vault = await import('../lib/storage/vault');
  database = await import('../lib/storage/database');
  guards = await import('../lib/auth/guards');
  workStorage = await import('next/dist/server/app-render/work-async-storage.external');
  requestStorage = await import('next/dist/server/app-render/work-unit-async-storage.external');
  cookies = await import('next/dist/server/web/spec-extension/cookies');
  iron = await import('iron-session');
  loginRoute = await import('../app/api/auth/login/route');
  logoutRoute = await import('../app/api/auth/logout/route');
  statusRoute = await import('../app/api/auth/status/route');
  activityRoute = await import('../app/api/auth/activity/route');
  settingsRoute = await import('../app/api/admin/session-settings/route');
  settings = await import('../lib/auth/security-settings');
  fixture = { version: 1, admin: { id: 'local-admin', username: 'admin', passwordHash: await store.hashPassword('synthetic-admin-password') }, primary: { id: 'primary', username: 'operator', passwordHash: await store.hashPassword(password), version: 1 } };
});
beforeEach(async () => {
  registry.revoke(); registry.configure(15);
  await vault.vaultLock();
  await Promise.all((await readdir(directory)).map(name => rm(join(directory, name), { recursive: true, force: true })));
  await store.updateAuth(() => structuredClone(fixture));
});
afterEach(async () => {
  registry.revoke();
  await mutex.withAuthOperation(() => vault.vaultLock());
});
after(async () => { await database.closeDatabase(); await rm(directory, { recursive: true, force: true }); });

async function context<T>(session: SessionData | string, task: () => Promise<T>) {
  const jar = new cookies.ResponseCookies(new Headers());
  jar.set('tdb_session', typeof session === 'string' ? session : await iron.sealData(session, { password: secret }));
  const work = { isStaticGeneration: false, route: '/api/auth/test', page: '/api/auth/test/route' } as WorkStore;
  const request = { type: 'request', phase: 'action', cookies: jar, userspaceMutableCookies: jar, mutableCookies: jar } as unknown as RequestStore;
  const result = await workStorage.workAsyncStorage.run(work, () => requestStorage.workUnitAsyncStorage.run(request, task));
  return { result, cookie: jar.get('tdb_session')!.value };
}
function post(path: string, body?: unknown, origin = 'http://localhost') {
  return new Request(`http://localhost${path}`, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function login(role: 'user' | 'admin' = 'user') {
  const result = await context({}, () => loginRoute.POST(post('/api/auth/login', { username: role === 'admin' ? 'admin' : 'operator', password: role === 'admin' ? 'synthetic-admin-password' : password })));
  assert.equal(result.result.status, 200);
  return result.cookie;
}
async function status(cookie: string) { return (await context(cookie, () => statusRoute.GET())).result.json(); }
const rejectsStatus = (status: number) => (error: unknown) => error instanceof Response && error.status === status;

test('genuine login cookies expire despite status polls, reject replay after a new login and after logout', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const old = await login();
  const deadline = (await status(old)).idleExpiresAt;
  for (let i = 0; i < 14; i++) { t.mock.timers.tick(60_000); assert.equal((await status(old)).idleExpiresAt, deadline); }
  t.mock.timers.tick(60_000);
  assert.equal((await status(old)).authenticated, false);
  await context(old, () => assert.rejects(guards.requireUser(), rejectsStatus(401)));
  assert.equal((await context(old, () => activityRoute.POST(post('/api/auth/activity')))).result.status, 401);
  const fresh = await login();
  assert.equal((await status(old)).authenticated, false);
  await context(old, () => logoutRoute.POST(post('/api/auth/logout')));
  assert.equal((await status(fresh)).authenticated, true, 'old logout cannot revoke a newer login');
  await context(fresh, () => logoutRoute.POST(post('/api/auth/logout')));
  assert.equal((await status(fresh)).authenticated, false);
});

test('second login revokes an otherwise live cookie, and legacy cookies without IDs cannot use guards or activity', async () => {
  const first = await login();
  const second = await login();
  assert.equal((await status(first)).authenticated, false);
  assert.equal((await status(second)).authenticated, true);
  const legacy = await iron.unsealData<SessionData>(second, { password: secret }); delete legacy.sessionId;
  await context(legacy, () => assert.rejects(guards.requireUser(), rejectsStatus(401)));
  assert.equal((await context(legacy, () => activityRoute.POST(post('/api/auth/activity')))).result.status, 401);
  assert.equal((await context(legacy, () => statusRoute.GET())).result.status, 200);
  assert.equal(await (await context(legacy, () => statusRoute.GET())).result.json().then(x => x.authenticated), false);
});

test('activity refreshes only live sessions and rejects foreign origins', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const cookie = await login();
  const deadline = (await status(cookie)).idleExpiresAt;
  t.mock.timers.tick(60_000);
  assert.equal((await context(cookie, () => activityRoute.POST(post('/api/auth/activity', undefined, 'https://foreign.example')))).result.status, 403);
  assert.equal((await status(cookie)).idleExpiresAt, deadline);
  assert.equal((await context(cookie, () => activityRoute.POST(post('/api/auth/activity')))).result.status, 200);
  assert.equal((await status(cookie)).idleExpiresAt, deadline + 60_000);
});

test('admin settings enforce roles/bounds/origin, persist disabled locally and never alter sync account metadata', async (t) => {
  const user = await login();
  assert.equal((await context(user, () => settingsRoute.POST(post('/api/admin/session-settings', { idleTimeoutMinutes: null })))).result.status, 403);
  const admin = await login('admin');
  const before = await readFile(join(directory, 'auth.json'), 'utf8');
  assert.deepEqual(await (await context(admin, () => settingsRoute.GET())).result.json(), { idleTimeoutMinutes: 15 });
  for (const value of [0, -1, 1441, 1.5, '15', false]) assert.equal((await context(admin, () => settingsRoute.POST(post('/api/admin/session-settings', { idleTimeoutMinutes: value })))).result.status, 400);
  assert.equal((await context(admin, () => settingsRoute.POST(post('/api/admin/session-settings', { idleTimeoutMinutes: 1, extra: true })))).result.status, 400);
  assert.equal((await context(admin, () => settingsRoute.POST(post('/api/admin/session-settings', { idleTimeoutMinutes: 1 }, 'https://foreign.example')))).result.status, 403);
  assert.equal((await context(admin, () => settingsRoute.POST(post('/api/admin/session-settings', { idleTimeoutMinutes: null })))).result.status, 200);
  assert.deepEqual(JSON.parse(await readFile(settings.securitySettingsPath(), 'utf8')), { version: 1, idleTimeoutMinutes: null });
  assert.equal(await readFile(join(directory, 'auth.json'), 'utf8'), before);
  registry.revoke(); registry.configure(15); // Process-local registry reset, persisted settings retained.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const reloaded = await login('admin');
  t.mock.timers.tick(1441 * 60_000);
  assert.equal((await status(reloaded)).authenticated, true);
  assert.equal((await status(reloaded)).idleTimeoutMinutes, null);
});

test('server timer locks a genuinely encrypted, unlocked SQLite vault with no HTTP at expiry', async (t) => {
  const management = await import('../lib/storage/access-management');
  const prepared = await management.prepareEncryption(fixture.admin!.id, password);
  await management.enableEncryption(fixture.admin!.id, password, prepared.token, true);
  settings.writeSessionSettings({ idleTimeoutMinutes: 1 });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const cookie = await login();
  const db = await database.getDatabase();
  assert.equal(vault.vaultIsUnlocked(), true);
  t.mock.timers.tick(60_000);
  // Wait for the serialized timer transition, without making an HTTP request.
  await mutex.withAuthOperation(async () => {});
  assert.equal(vault.vaultIsUnlocked(), false);
  assert.throws(() => vault.vaultKey(), /заблокировано/);
  await assert.rejects(database.getDatabase(), /заблокировано/);
  await assert.rejects(db.person.count());
  assert.equal((await status(cookie)).authenticated, false);
  const fresh = await login();
  assert.equal(vault.vaultIsUnlocked(), true);
  await context(cookie, () => assert.rejects(guards.requireUser(), rejectsStatus(401)));
  assert.equal((await status(fresh)).authenticated, true);
});

test('expiry rejects immediately but waits for an active vault transition before locking', async (t) => {
  settings.writeSessionSettings({ idleTimeoutMinutes: 1 });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const cookie = await login('admin');
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const operation = mutex.withAuthOperation(async () => {
    t.mock.timers.tick(60_000);
    assert.equal((await status(cookie)).authenticated, false);
    await context(cookie, () => assert.rejects(guards.requireAdmin(), rejectsStatus(401)));
    await barrier;
  });
  release(); await operation;
  await mutex.withAuthOperation(async () => {});
});
