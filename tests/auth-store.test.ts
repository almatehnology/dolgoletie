import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { AuthMetadata } from '../lib/auth/types';

const runFile = promisify(execFile);
let directory: string;
let auth: typeof import('../lib/auth/store');
const fixtureHash = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$YWJj';
const fixture = (): AuthMetadata => ({ version: 1, admin: { id: 'local-admin', username: 'admin', passwordHash: fixtureHash }, primary: { id: 'shared-user', username: 'operator', passwordHash: fixtureHash, version: 1 } });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'travel-auth-store-'));
  process.env.DATA_DIR = directory;
  process.env.AUTH_FILE = join(directory, 'auth.json');
  process.env.DATABASE_URL = `file:${join(directory, 'data.db')}`;
  process.env.SESSION_SECRET = 'auth-store-test-only-session-secret-32-chars';
  process.env.APP_PASSWORD = '';
  auth = await import('../lib/auth/store');
});
beforeEach(async () => {
  await Promise.all((await readdir(directory)).map((name) => rm(join(directory, name), { recursive: true, force: true })));
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

test('AUTH_FILE overrides DATA_DIR; a missing installation has no accounts', async () => {
  assert.equal(auth.authFilePath(), join(directory, 'auth.json'));
  assert.deepEqual(await auth.readAuth(), { version: 1 });
  delete process.env.AUTH_FILE;
  assert.equal(auth.authFilePath(), join(directory, 'auth.json'));
  process.env.AUTH_FILE = join(directory, 'auth.json');
});

test('atomic metadata writes use 0600; read repairs permissive permissions', async () => {
  await auth.updateAuth(() => fixture());
  assert.deepEqual(await auth.readAuth(), fixture());
  if (process.platform !== 'win32') assert.equal((await lstat(auth.authFilePath())).mode & 0o777, 0o600);
  await chmod(auth.authFilePath(), 0o644);
  await auth.readAuth();
  if (process.platform !== 'win32') assert.equal((await lstat(auth.authFilePath())).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['auth.json']);
});

test('async mutations are serialized without lost versions and readers see valid JSON', async () => {
  await auth.updateAuth(() => fixture());
  const updates = Array.from({ length: 30 }, () => auth.updateAuth(async (data) => {
    const previous = data.primary!.version;
    await new Promise((resolve) => setTimeout(resolve, 1));
    data.primary!.version = previous + 1;
  }));
  const snapshots = Array.from({ length: 30 }, async () => {
    const data = await auth.readAuth();
    assert.ok(data.primary!.version >= 1 && data.primary!.version <= 31);
  });
  await Promise.all([...updates, ...snapshots]);
  assert.equal((await auth.readAuth()).primary?.version, 31);
});

test('separate processes serialize through the file lock', async () => {
  await auth.updateAuth(() => fixture());
  const modulePath = pathToFileURL(resolve('lib/auth/store.ts')).href;
  const script = `const module = await import(${JSON.stringify(modulePath)}); const { updateAuth } = module.default ?? module; for (let i=0; i<12; i++) await updateAuth(async value => { const version=value.primary.version; await new Promise(resolve => setTimeout(resolve, 2)); value.primary.version=version+1; });`;
  await Promise.all(Array.from({ length: 3 }, () => runFile(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { env: process.env })));
  assert.equal((await auth.readAuth()).primary?.version, 37);
  assert.deepEqual(await readdir(directory), ['auth.json']);
});

test('a failed mutation releases locks and preserves the prior metadata', async () => {
  await auth.updateAuth(() => fixture());
  const before = await readFile(auth.authFilePath(), 'utf8');
  await assert.rejects(auth.updateAuth((data) => { data.primary!.version++; throw new Error('fixture failure'); }));
  assert.equal(await readFile(auth.authFilePath(), 'utf8'), before);
  await auth.updateAuth((data) => { data.primary!.version++; });
  assert.equal((await auth.readAuth()).primary?.version, 2);
  assert.deepEqual(await readdir(directory), ['auth.json']);
});

test('corrupt metadata fails closed and cannot be silently replaced by setup', async () => {
  await writeFile(auth.authFilePath(), '{invalid JSON', { mode: 0o600 });
  await assert.rejects(auth.readAuth(), (error: unknown) => error instanceof auth.AuthStoreError && error.code === 'INVALID_METADATA');
  await assert.rejects(auth.updateAuth(() => fixture()));
  assert.equal(await readFile(auth.authFilePath(), 'utf8'), '{invalid JSON');
});

test('metadata symlinks are rejected without reading or changing the target', async (t) => {
  const target = join(directory, 'untouched.json');
  await writeFile(target, JSON.stringify(fixture()), { mode: 0o644 });
  try { await symlink(target, auth.authFilePath()); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Windows symlink creation unavailable: Developer Mode or link privileges required');
      return;
    }
    throw error;
  }
  await assert.rejects(auth.readAuth(), (error: unknown) => error instanceof auth.AuthStoreError && error.code === 'UNSAFE_FILE');
  await assert.rejects(auth.updateAuth(() => fixture()));
  if (process.platform !== 'win32') assert.equal((await lstat(target)).mode & 0o777, 0o644);
});

test('unknown versions, plaintext credentials and duplicate identities are rejected', async () => {
  await assert.rejects(auth.updateAuth(() => ({ ...fixture(), version: 2 }) as unknown as AuthMetadata));
  await assert.rejects(auth.updateAuth(() => { const data = fixture(); data.admin!.passwordHash = 'plaintext'; return data; }));
  await assert.rejects(auth.updateAuth(() => { const data = fixture(); data.primary!.id = data.admin!.id; return data; }));
  assert.deepEqual(await auth.readAuth(), { version: 1 });
});

test('readAuth first recovers an interrupted credential transaction', async () => {
  await auth.updateAuth(() => fixture());
  const next = fixture();
  next.primary!.version = 2;
  await writeFile(join(directory, 'credential-transition.json'), JSON.stringify({ format: 1, auth: next, vault: { format: 1, enabled: false, accessRevision: 'synthetic-revision' } }), { mode: 0o600 });
  assert.deepEqual(await auth.readAuth(), next);
  assert.ok(!(await readdir(directory)).includes('credential-transition.json'));
  if (process.platform !== 'win32') assert.equal((await lstat(auth.authFilePath())).mode & 0o777, 0o600);
});
