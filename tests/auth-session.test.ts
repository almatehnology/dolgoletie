import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthMetadata, SessionData } from '../lib/auth/types';

let directory: string;
let authorization: typeof import('../lib/auth/authorization');
let passwords: typeof import('../lib/auth/password');
let store: typeof import('../lib/auth/store');
const fixtureHash = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$YWJj';
const fixture = (): AuthMetadata => ({ version: 1, admin: { id: 'local-admin', username: 'admin', passwordHash: fixtureHash }, primary: { id: 'shared-user', username: 'operator', passwordHash: fixtureHash, version: 4 } });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'travel-auth-session-'));
  process.env.DATA_DIR = directory;
  process.env.AUTH_FILE = join(directory, 'auth.json');
  process.env.DATABASE_URL = `file:${join(directory, 'data.db')}`;
  process.env.SESSION_SECRET = 'auth-session-test-only-secret-with-32-chars';
  process.env.APP_PASSWORD = '';
  authorization = await import('../lib/auth/authorization');
  passwords = await import('../lib/auth/password');
  store = await import('../lib/auth/store');
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

function throwsStatus(status: number) { return (error: unknown) => error instanceof Response && error.status === status; }
const userSession = (): SessionData => ({ authenticated: true, userId: 'shared-user', role: 'user', authVersion: 4 });

test('Argon2id creates salted hashes, rejects wrong passwords and never accepts legacy/plaintext hashes', async () => {
  const password = 'synthetic-long-password';
  const first = await passwords.hashPassword(password);
  const second = await passwords.hashPassword(password);
  assert.ok(first.startsWith('$argon2id$'));
  assert.notEqual(first, second);
  assert.ok(await passwords.verifyPassword(first, password));
  assert.equal(await passwords.verifyPassword(first, 'wrong-password'), false);
  assert.equal(await passwords.verifyPassword(password, password), false);
  assert.equal(await passwords.verifyPassword('$argon2id$malformed', password), false);
});

test('legacy authenticated cookies, altered role/id and stale versions fail server authorization', () => {
  const auth = fixture();
  assert.equal(authorization.authorizeSession(userSession(), auth, 'user').id, 'shared-user');
  for (const session of [{ authenticated: true }, { ...userSession(), role: 'admin' as const }, { ...userSession(), userId: 'other' }, { ...userSession(), authVersion: 3 }, { ...userSession(), authenticated: false }]) {
    assert.throws(() => authorization.authorizeSession(session, auth, 'user'), throwsStatus(401));
  }
});

test('current admin cannot read user content and user cannot administer accounts', () => {
  const auth = fixture();
  const admin: SessionData = { authenticated: true, userId: auth.admin!.id, role: 'admin', authVersion: authorization.accountVersion(auth.admin!) };
  assert.equal(authorization.authorizeSession(admin, auth, 'admin').username, 'admin');
  assert.throws(() => authorization.authorizeSession(admin, auth, 'user'), throwsStatus(403));
  assert.throws(() => authorization.authorizeSession(userSession(), auth, 'admin'), throwsStatus(403));
});

test('metadata access changes revoke a cookie on the next check, without a restart', async () => {
  await store.updateAuth(() => fixture());
  authorization.authorizeSession(userSession(), await store.readAuth(), 'user');
  await store.updateAuth((auth) => { auth.primary!.version++; });
  assert.throws(() => authorization.authorizeSession(userSession(), { ...fixture(), primary: { ...fixture().primary!, version: 5 } }, 'user'), throwsStatus(401));
  const latest = await store.readAuth();
  assert.throws(() => authorization.authorizeSession(userSession(), latest, 'user'), throwsStatus(401));
});

test('local admin credential changes revoke admin cookies; a closed vault denies content', () => {
  const auth = fixture();
  const admin: SessionData = { authenticated: true, userId: auth.admin!.id, role: 'admin', authVersion: authorization.accountVersion(auth.admin!) };
  auth.admin!.passwordHash = auth.admin!.passwordHash.replace('YWJj', 'ZGVm');
  assert.throws(() => authorization.authorizeSession(admin, auth, 'admin'), throwsStatus(401));
  assert.throws(() => authorization.assertVaultUnlocked(false), throwsStatus(423));
  authorization.assertVaultUnlocked(true);
});

test('the sealed cookie contains only session identity and never raw passwords, keys or hashes', async () => {
  const { sealData, unsealData } = await import('iron-session');
  const password = 'synthetic-cookie-signing-secret-longer-than-32';
  const cookie = await sealData(userSession(), { password });
  const contents = await unsealData<SessionData>(cookie, { password });
  assert.deepEqual(contents, userSession());
  assert.ok(!cookie.includes(fixtureHash));
  assert.deepEqual(Object.keys(contents).sort(), ['authVersion', 'authenticated', 'role', 'userId']);
});

test('account navigation resets RTK Query, closes search and uses a full document navigation', async () => {
  const { makeStore } = await import('../lib/store');
  const { openSearchModal, toggleScansRevealed, pushToast } = await import('../lib/store/ui-slice');
  const { api } = await import('../lib/store/api');
  const { clearClientSession, leaveAccount, safeUserDestination } = await import('../lib/auth/client');
  const redux = makeStore();
  redux.dispatch(openSearchModal());
  redux.dispatch(toggleScansRevealed('synthetic-person'));
  redux.dispatch(pushToast({ id: 'synthetic-toast', kind: 'info', message: 'synthetic display data' }));
  const testApi = api.injectEndpoints({ endpoints: (builder) => ({ authSyntheticContent: builder.query<{ value: string }, void>({ queryFn: async () => ({ data: { value: 'synthetic content' } }) }) }) });
  await redux.dispatch(testApi.endpoints.authSyntheticContent.initiate(undefined, { subscribe: false }));
  assert.ok(Object.keys(redux.getState().api.queries).length > 0);
  clearClientSession(redux);
  assert.equal(redux.getState().ui.searchModalOpen, false);
  assert.equal(redux.getState().ui.scansRevealedFor['synthetic-person'], false);
  assert.deepEqual(redux.getState().ui.toasts, []);
  assert.deepEqual(redux.getState().api.queries, {});
  assert.equal(safeUserDestination('/people?page=2'), '/people?page=2');
  for (const destination of ['//other.example', '/\\other.example', '/admin', '/api/export', '/login', 'https://other.example', '/%2fother.example']) {
    assert.equal(safeUserDestination(destination), '/');
  }
  const previousFetch = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const requests: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { replace: (path: string) => requests.push(path) } } });
  globalThis.fetch = async () => { requests.push('logout'); return Response.json({ ok: true }); };
  try {
    await leaveAccount(redux, '/login?role=admin');
    assert.deepEqual(requests, ['logout', '/login?role=admin']);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
