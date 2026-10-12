import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, access, writeFile, readFile, mkdir } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { wrapPassword, wrapRecovery, createRecoveryCode } from '../lib/crypto/primitives';

test('Docker upload mount survives encryption, interrupted cleanup recovery and subsequent logins', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tdb-mounted-uploads-'));
  const uploads = join(dir, 'uploads');
  process.env.DATA_DIR = dir; process.env.DATABASE_URL = `file:${join(dir, 'data.db')}`;
  process.env.UPLOADS_DIR = uploads; process.env.AUTH_FILE = join(dir, 'auth.json'); process.env.APP_PASSWORD = '';
  await mkdir(uploads);
  const originalRemove = fs.rmSync;
  const mountGuard = t.mock.method(fs, 'rmSync', (path: Parameters<typeof fs.rmSync>[0], options: Parameters<typeof fs.rmSync>[1]) => {
    if (String(path) === uploads) throw Object.assign(new Error('Cannot remove mounted directory'), { code: 'EBUSY' });
    return originalRemove(path, options);
  });
  syncBuiltinESMExports();
  const { createAdmin, createPrimary, authenticateAccount } = await import('../lib/auth/accounts');
  const { readAuth } = await import('../lib/auth/store');
  const { accountVersion } = await import('../lib/auth/authorization');
  const { prepareEncryption, enableEncryption, disableEncryption } = await import('../lib/storage/access-management');
  const { atomicJson } = await import('../lib/storage/atomic-files');
  const vault = await import('../lib/storage/vault');
  const { prisma } = await import('../lib/db');
  try {
    await createAdmin('mounted-admin-password');
    const admin = (await readAuth()).admin!;
    await createPrimary({ authenticated: true, role: 'admin', userId: admin.id, authVersion: accountVersion(admin) }, 'operator', 'mounted-user-password');
    const prepared = await prepareEncryption(admin.id, 'mounted-user-password');
    await enableEncryption(admin.id, 'mounted-user-password', prepared.token, true);
    assert.equal(vault.readVault().enabled, true);
    assert.deepEqual(await readdir(uploads), []);
    // Recreate the pending cleanup left by the old release after a committed switch.
    await mkdir(join(uploads, 'old-person'));
    await writeFile(join(uploads, 'old-person', 'document.txt'), 'old plaintext attachment');
    await writeFile(join(dir, 'data.db'), 'old plaintext database');
    atomicJson(join(dir, 'storage-transition.json'), { format: 1, source: null, target: vault.readVault().generation });
    assert.equal((await authenticateAccount('admin', 'mounted-admin-password', vault)).role, 'admin');
    assert.deepEqual(await readdir(uploads), []);
    await assert.rejects(access(join(dir, 'data.db')));
    await assert.rejects(access(join(dir, 'storage-transition.json')));
    assert.equal((await authenticateAccount('operator', 'mounted-user-password', vault)).role, 'user');
    assert.equal(await prisma.person.count(), 0);
    await disableEncryption(prepared.recoveryCode, true);
    assert.equal((await authenticateAccount('admin', 'mounted-admin-password', vault)).role, 'admin');
    assert.equal((await authenticateAccount('operator', 'mounted-user-password', vault)).role, 'user');
    assert.equal(await prisma.person.count(), 0);
    assert.equal(mountGuard.mock.calls.some(call => String(call.arguments[0]) === uploads), false);
  } finally {
    mountGuard.mock.restore(); syncBuiltinESMExports();
    await vault.vaultLock(); await prisma.$disconnect(); await rm(dir, { recursive: true, force: true });
  }
});

test('interrupted generation preparation rolls back, while a durable credential intent completes the generation and removes plaintext', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tdb-generation-'));
  process.env.DATA_DIR = dir; process.env.DATABASE_URL = `file:${join(dir, 'data.db')}`;
  process.env.UPLOADS_DIR = join(dir, 'uploads'); process.env.AUTH_FILE = join(dir, 'auth.json'); process.env.APP_PASSWORD = '';
  const { updateAuth, readAuth, hashPassword } = await import('../lib/auth/store');
  const { prisma } = await import('../lib/db');
  const { writeScanFile, readScanFile } = await import('../lib/uploads');
  const { convertVault, readVault, vaultUnlock, vaultLock } = await import('../lib/storage/vault');
  const { atomicJson } = await import('../lib/storage/atomic-files');
  const root = randomBytes(32), password = 'new-password-after-recovery';
  try {
    await updateAuth(async () => ({ version: 1, admin: { id: 'local-admin', username: 'admin', passwordHash: await hashPassword('administrator-password') }, primary: { id: 'user', username: 'operator', passwordHash: await hashPassword('old-primary-password'), version: 1 } }));
    const person = await prisma.person.create({ data: { firstName: 'Мария', lastName: 'Сохранённая' } });
    await writeScanFile(`${person.id}/document.txt`, Buffer.from('important attachment'));
    const target = { root, passwordSlot: await wrapPassword(root, password), recoverySlot: wrapRecovery(root, createRecoveryCode()), accessRevision: 'transition-revision' };
    await assert.rejects(convertVault(true, 'old-primary-password', false, target, () => { throw new Error('before commit'); }), /before commit/);
    assert.equal(readVault().enabled, false);
    assert.deepEqual(await readdir(join(dir, 'vaults')), []);
    assert.equal((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).lastName, 'Сохранённая');
    assert.equal((await readScanFile(`${person.id}/document.txt`)).toString(), 'important attachment');
    const next = await readAuth(); next.primary!.passwordHash = await hashPassword(password); next.primary!.version++;
    // A process can exit after fsync(marker), before either final file has been renamed.
    await assert.rejects(convertVault(true, 'old-primary-password', false, target, config => {
      atomicJson(join(dir, 'credential-transition.json'), { format: 1, auth: next, vault: config });
      throw new Error('after durable intent');
    }), /after durable intent/);
    assert.equal(readVault().enabled, true);
    assert.equal((await readAuth()).primary!.passwordHash, next.primary!.passwordHash);
    await assert.rejects(access(join(dir, 'data.db')));
    assert.deepEqual(await readdir(join(dir, 'uploads')), []);
    await assert.rejects(access(join(dir, 'storage-transition.json')));
    await vaultUnlock(password);
    assert.equal((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).lastName, 'Сохранённая');
    assert.equal((await readScanFile(`${person.id}/document.txt`)).toString(), 'important attachment');
  } finally { root.fill(0); await vaultLock(); await rm(dir, { recursive: true, force: true }); }
});

test('credential recovery rejects malformed identities and unsafe marker files without replacing credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tdb-credential-invalid-'));
  process.env.DATA_DIR = dir; process.env.AUTH_FILE = join(dir, 'auth.json');
  const { recoverCredentialTransition } = await import('../lib/storage/credential-transaction');
  try {
    await writeFile(join(dir, 'auth.json'), 'untouched');
    await writeFile(join(dir, 'credential-transition.json'), JSON.stringify({ format: 1, auth: { version: 1, primary: { username: 'admin' } }, vault: { format: 1, enabled: false, accessRevision: 'initial' } }));
    assert.throws(recoverCredentialTransition);
    assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), 'untouched');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
