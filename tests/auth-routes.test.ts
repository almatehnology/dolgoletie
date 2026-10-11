import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AuthMetadata, SessionData } from '../lib/auth/types';
import type { RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external';
import type { WorkStore } from 'next/dist/server/app-render/work-async-storage.external';

let directory: string;
let store: typeof import('../lib/auth/store');
let guards: typeof import('../lib/auth/guards');
let authorization: typeof import('../lib/auth/authorization');
let workStorage: typeof import('next/dist/server/app-render/work-async-storage.external');
let requestStorage: typeof import('next/dist/server/app-render/work-unit-async-storage.external');
let nextCookies: typeof import('next/dist/server/web/spec-extension/cookies');
let iron: typeof import('iron-session');
let nextServer: typeof import('next/server');
let authMiddleware: typeof import('../middleware');
let loginRoute: typeof import('../app/api/auth/login/route');
let logoutRoute: typeof import('../app/api/auth/logout/route');
let adminStatus: typeof import('../app/api/admin/status/route');
let adminUser: typeof import('../app/api/admin/user/route');
let fixture: AuthMetadata;
const secret = 'synthetic-auth-route-session-secret-32-characters';

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'travel-auth-routes-'));
  process.env.DATA_DIR = directory;
  process.env.AUTH_FILE = join(directory, 'auth.json');
  process.env.DATABASE_URL = `file:${join(directory, 'data.db')}`;
  process.env.UPLOADS_DIR = join(directory, 'uploads');
  process.env.SESSION_SECRET = secret;
  process.env.APP_PASSWORD = '';
  // Next normally installs this global before initializing its request stores.
  Object.assign(globalThis, { AsyncLocalStorage });
  store = await import('../lib/auth/store');
  guards = await import('../lib/auth/guards');
  authorization = await import('../lib/auth/authorization');
  workStorage = await import('next/dist/server/app-render/work-async-storage.external');
  requestStorage = await import('next/dist/server/app-render/work-unit-async-storage.external');
  nextCookies = await import('next/dist/server/web/spec-extension/cookies');
  iron = await import('iron-session');
  nextServer = await import('next/server');
  authMiddleware = await import('../middleware');
  loginRoute = await import('../app/api/auth/login/route');
  logoutRoute = await import('../app/api/auth/logout/route');
  adminStatus = await import('../app/api/admin/status/route');
  adminUser = await import('../app/api/admin/user/route');
  fixture = {
    version: 1,
    admin: { id: 'local-admin', username: 'admin', passwordHash: await store.hashPassword('synthetic-admin-password') },
    primary: { id: 'shared-user', username: 'operator', passwordHash: await store.hashPassword('synthetic-user-password'), version: 1 },
  };
});
beforeEach(async () => {
  await Promise.all((await readdir(directory)).map((name) => rm(join(directory, name), { recursive: true, force: true })));
  await store.updateAuth(() => structuredClone(fixture));
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

function sessionFor(role: 'user' | 'admin'): SessionData {
  const account = role === 'admin' ? fixture.admin! : fixture.primary!;
  return { authenticated: true, role, userId: account.id, authVersion: authorization.accountVersion(account) };
}

async function requestContext<T>(session: SessionData, task: () => Promise<T>) {
  const jar = new nextCookies.ResponseCookies(new Headers());
  jar.set('tdb_session', await iron.sealData(session, { password: secret }));
  const work = { isStaticGeneration: false, route: '/api/auth/test', page: '/api/auth/test/route' } as WorkStore;
  const request = { type: 'request', phase: 'action', cookies: jar, userspaceMutableCookies: jar, mutableCookies: jar } as unknown as RequestStore;
  const result = await workStorage.workAsyncStorage.run(work, () => requestStorage.workUnitAsyncStorage.run(request, task));
  return { result, jar };
}

function rejectsStatus(status: number) { return (error: unknown) => error instanceof Response && error.status === status; }

test('real guards read the current cookie role/version on each request', async () => {
  await requestContext(sessionFor('user'), async () => {
    assert.equal((await guards.requireUser()).id, 'shared-user');
    await assert.rejects(guards.requireAdmin(), rejectsStatus(403));
    await store.updateAuth((auth) => { auth.primary!.version++; });
    await assert.rejects(guards.requireUser(), rejectsStatus(401));
  });
  await requestContext(sessionFor('admin'), async () => {
    assert.equal((await guards.requireAdmin()).id, 'local-admin');
    await assert.rejects(guards.requireUser(), rejectsStatus(403));
  });
});

test('an encrypted locked vault denies a valid user cookie while keeping admin management available', async () => {
  // Synthetic slots only: this test never opens the database or attempts decryption.
  const slot = { salt: Buffer.alloc(16).toString('base64'), nonce: Buffer.alloc(12).toString('base64'), tag: Buffer.alloc(16).toString('base64'), value: Buffer.alloc(32).toString('base64'), memoryCost: 65536, timeCost: 3, parallelism: 1 };
  await writeFile(join(directory, 'vault.json'), JSON.stringify({ format: 1, enabled: true, passwordSlot: slot, recoverySlot: slot, accessRevision: 'synthetic-revision' }), { mode: 0o600 });
  await requestContext(sessionFor('user'), async () => { await assert.rejects(guards.requireUser(), rejectsStatus(423)); });
  await requestContext(sessionFor('admin'), async () => { assert.equal((await guards.requireAdmin()).username, 'admin'); });
});

test('admin endpoints return caught authorization Responses and redact hashes', async () => {
  await requestContext(sessionFor('user'), async () => { assert.equal((await adminStatus.GET()).status, 403); });
  await requestContext({ authenticated: true }, async () => { assert.equal((await adminStatus.GET()).status, 401); });
  await requestContext(sessionFor('admin'), async () => {
    const response = await adminStatus.GET();
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.primary, { id: 'shared-user', username: 'operator', version: 1 });
    assert.equal(data.encryptionEnabled, false);
    assert.ok(!JSON.stringify(data).includes('passwordHash'));
  });
});

test('the admin user endpoint refuses a second account and stale admin sessions', async () => {
  const request = () => new Request('http://localhost/api/admin/user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'new-user', password: 'synthetic-new-user-password' }) });
  await requestContext(sessionFor('admin'), async () => {
    assert.equal((await adminUser.POST(request())).status, 409);
    await store.updateAuth((auth) => { auth.admin!.id = 'changed-local-admin'; });
    assert.equal((await adminUser.POST(request())).status, 401);
  });
});

test('admin login replaces a user cookie with only admin identity; logout destroys it', async () => {
  const { result: response, jar } = await requestContext(sessionFor('user'), () => loginRoute.POST(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'synthetic-admin-password' }) })));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, role: 'admin', next: '/admin' });
  const stored = await iron.unsealData<SessionData>(jar.get('tdb_session')!.value, { password: secret });
  assert.deepEqual(stored, sessionFor('admin'));
  assert.equal(jar.get('tdb_session')?.httpOnly, true);
  const loggedOut = await requestContext(stored, () => logoutRoute.POST(new Request('http://localhost/api/auth/logout', { method: 'POST' })));
  assert.equal(loggedOut.result.status, 200);
  assert.equal(loggedOut.jar.get('tdb_session')?.value, '');
});

test('middleware keeps core routes and blocks both cross-role API directions', async () => {
  async function check(path: string, session: SessionData) {
    const cookie = await iron.sealData(session, { password: secret });
    return authMiddleware.middleware(new nextServer.NextRequest(`http://localhost${path}`, { headers: { Cookie: `tdb_session=${cookie}` } }));
  }
  for (const path of ['/', '/people', '/events', '/archive', '/data', '/api/search', '/api/people', '/api/export']) {
    const allowed = await check(path, sessionFor('user'));
    assert.equal(allowed.headers.get('x-middleware-next'), '1');
  }
  for (const path of ['/api/search', '/api/people', '/api/scans/example', '/api/import', '/api/reset']) {
    assert.equal((await check(path, sessionFor('admin'))).status, 403);
  }
  assert.equal((await check('/api/admin/status', sessionFor('user'))).status, 403);
  assert.equal((await check('/api/people', { authenticated: true })).status, 401);
  assert.equal((await check('/people', sessionFor('admin'))).headers.get('location'), 'http://localhost/admin');
});

test('middleware rejects foreign Origins for unsafe API methods, including public setup/login', async () => {
  for (const path of ['/api/setup', '/api/auth/login', '/api/auth/logout', '/api/people', '/api/admin/user']) {
    const request = new nextServer.NextRequest(`http://localhost${path}`, { method: 'POST', headers: { Origin: 'https://other.example' } });
    const result = await authMiddleware.middleware(request);
    assert.equal(result.status, 403);
    assert.equal((await result.json()).error.code, 'FORBIDDEN');
  }
  const accepted = await authMiddleware.middleware(new nextServer.NextRequest('http://localhost/api/setup', { method: 'POST', headers: { Origin: 'http://localhost' } }));
  assert.equal(accepted.headers.get('x-middleware-next'), '1');
});
