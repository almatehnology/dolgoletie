import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionData, VaultHooks } from '../lib/auth/types';

let directory: string;
let store: typeof import('../lib/auth/store');
let accounts: typeof import('../lib/auth/accounts');
let authorization: typeof import('../lib/auth/authorization');
let setupRoute: typeof import('../app/api/setup/route');
const adminPassword = 'synthetic-admin-password';
const userPassword = 'synthetic-user-password';

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'travel-auth-accounts-'));
  process.env.DATA_DIR = directory;
  process.env.AUTH_FILE = join(directory, 'auth.json');
  process.env.DATABASE_URL = `file:${join(directory, 'data.db')}`;
  process.env.SESSION_SECRET = 'auth-accounts-test-only-session-secret-32-chars';
  process.env.APP_PASSWORD = '';
  store = await import('../lib/auth/store');
  accounts = await import('../lib/auth/accounts');
  authorization = await import('../lib/auth/authorization');
  setupRoute = await import('../app/api/setup/route');
});
beforeEach(async () => {
  process.env.APP_PASSWORD = '';
  await Promise.all((await readdir(directory)).map((name) => rm(join(directory, name), { recursive: true, force: true })));
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

function rejectsStatus(status: number) {
  return (error: unknown) => error instanceof Response && error.status === status;
}

async function adminSession(): Promise<SessionData> {
  await accounts.createAdmin(adminPassword);
  const admin = (await store.readAuth()).admin!;
  return { authenticated: true, userId: admin.id, role: 'admin', authVersion: authorization.accountVersion(admin) };
}

function fakeVault() {
  const calls: string[] = [];
  let unlocked = true;
  const hooks: VaultHooks = {
    async vaultLock() { calls.push('lock'); unlocked = false; },
    async vaultUnlock(password) { assert.equal(password, userPassword); calls.push('unlock'); unlocked = true; },
    vaultIsUnlocked() { return unlocked; },
    vaultEncryptionEnabled() { return true; },
  };
  return { calls, hooks };
}

test('two first-run requests can create only one admin; public status never exposes hashes', async () => {
  const request = () => new Request('http://localhost/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: adminPassword }) });
  const responses = await Promise.all([setupRoute.POST(request()), setupRoute.POST(request())]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const metadata = await store.readAuth();
  assert.equal(metadata.admin?.username, 'admin');
  assert.ok(await store.verifyPassword(metadata.admin!.passwordHash, adminPassword));
  const publicStatus = await (await setupRoute.GET()).json();
  assert.deepEqual(publicStatus, { configured: true, legacyConfirmationRequired: false, canSetup: false });
  assert.ok(!JSON.stringify(publicStatus).includes(metadata.admin!.passwordHash));
});

test('legacy ownership proof preserves the database byte for byte and is not a login credential', async () => {
  process.env.APP_PASSWORD = 'synthetic-legacy-password';
  const database = join(directory, 'data.db');
  const marker = Buffer.from('synthetic existing install: preserve all bytes');
  await writeFile(database, marker);
  await assert.rejects(accounts.createAdmin(adminPassword, 'wrong proof'), rejectsStatus(403));
  assert.deepEqual(await store.readAuth(), { version: 1 });
  await accounts.createAdmin(adminPassword, process.env.APP_PASSWORD);
  assert.deepEqual(await readFile(database), marker);
  await assert.rejects(accounts.authenticateAccount('admin', process.env.APP_PASSWORD!, fakeVault().hooks), rejectsStatus(401));
  await assert.rejects(accounts.createAdmin('another-admin-password', process.env.APP_PASSWORD), rejectsStatus(409));
});

test('existing data without a legacy ownership proof cannot be claimed as a new install', async () => {
  await writeFile(join(directory, 'data.db'), 'existing fixture');
  assert.deepEqual(await accounts.setupStatus(), { configured: false, legacyConfirmationRequired: false, canSetup: false });
  await assert.rejects(accounts.createAdmin(adminPassword), rejectsStatus(403));
});

test('only the current admin can create one singleton user, including concurrent requests', async () => {
  const session = await adminSession();
  await assert.rejects(accounts.createPrimary({}, 'operator', userPassword), rejectsStatus(401));
  const outcomes = await Promise.allSettled([accounts.createPrimary(session, 'operator', userPassword), accounts.createPrimary(session, 'another', userPassword)]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(outcomes.some((result) => result.status === 'rejected' && result.reason instanceof Response && result.reason.status === 409));
  const primary = (await store.readAuth()).primary!;
  await assert.rejects(accounts.createPrimary({ authenticated: true, userId: primary.id, role: 'user', authVersion: primary.version }, 'third', userPassword), rejectsStatus(403));
  await assert.rejects(accounts.createPrimary(session, 'ＡＤＭＩＮ', userPassword), rejectsStatus(400));
});

test('primary login locks previous content, unlocks using its password, and emits only session identity', async () => {
  const admin = await adminSession();
  await accounts.createPrimary(admin, 'operator', userPassword);
  const vault = fakeVault();
  const session = await accounts.authenticateAccount(' OPERATOR ', userPassword, vault.hooks);
  assert.deepEqual(vault.calls, ['lock', 'unlock']);
  assert.equal(session.role, 'user');
  assert.equal(session.authVersion, 1);
  assert.deepEqual(Object.keys(session).sort(), ['authVersion', 'authenticated', 'role', 'userId']);
  assert.ok(!JSON.stringify(session).includes(userPassword));
});

test('admin login and invalid account switches lock the vault without opening it', async () => {
  await adminSession();
  const vault = fakeVault();
  const session = await accounts.authenticateAccount('admin', adminPassword, vault.hooks);
  assert.equal(session.role, 'admin');
  assert.deepEqual(vault.calls, ['lock']);
  assert.equal(vault.hooks.vaultIsUnlocked(), false);
  await assert.rejects(accounts.authenticateAccount('missing', userPassword, vault.hooks), rejectsStatus(401));
  assert.deepEqual(vault.calls, ['lock', 'lock']);
});

test('credentials changed during unlock cannot grant a stale user session', async () => {
  const admin = await adminSession();
  await accounts.createPrimary(admin, 'operator', userPassword);
  const vault = fakeVault();
  const originalUnlock = vault.hooks.vaultUnlock;
  vault.hooks.vaultUnlock = async (password) => {
    await originalUnlock(password);
    await store.updateAuth((metadata) => { metadata.primary!.version++; });
  };
  await assert.rejects(accounts.authenticateAccount('operator', userPassword, vault.hooks), rejectsStatus(401));
  assert.deepEqual(vault.calls, ['lock', 'unlock', 'lock']);
});

test('failed unlock is relocked and returns a sanitized response', async () => {
  const admin = await adminSession();
  await accounts.createPrimary(admin, 'operator', userPassword);
  const vault = fakeVault();
  vault.hooks.vaultUnlock = async () => { throw new Error('synthetic private vault detail'); };
  try {
    await accounts.authenticateAccount('operator', userPassword, vault.hooks);
    assert.fail('Unlock failure should reject login');
  } catch (error) {
    assert.ok(error instanceof Response);
    assert.equal(error.status, 423);
    assert.ok(!(await error.text()).includes('private vault detail'));
  }
  assert.deepEqual(vault.calls, ['lock', 'lock']);
});

test('setup rejects cross-site browser mutations', async () => {
  const response = await setupRoute.POST(new Request('http://localhost/api/setup', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: adminPassword }) }));
  assert.equal(response.status, 403);
  assert.deepEqual(await store.readAuth(), { version: 1 });
});
