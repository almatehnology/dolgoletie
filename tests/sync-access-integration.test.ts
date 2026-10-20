import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { AdminAccount, SessionData } from '../lib/auth/types';
import type { TransferAccess } from '../lib/crypto/bundle';
import type { AccessDecision, AccessResult } from '../lib/sync/access';
import type { SyncJob } from '../lib/sync/jobs';
import type { RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external';
import type { WorkStore } from 'next/dist/server/app-render/work-async-storage.external';

const OLD_PASSWORD = 'synthetic-primary-old-password';
const NEW_PASSWORD = 'synthetic-primary-new-password';
const BRANCH_PASSWORD = 'synthetic-primary-branch-password';
const WRONG_PASSWORD = 'synthetic-incorrect-password';
const SESSION_SECRET = 'synthetic-sync-access-session-secret-32-characters';
const DOCUMENT = Buffer.from('%PDF-1.4\nSynthetic sync-access document; no personal data.\n%%EOF\n');
const ENV_KEYS = ['DATA_DIR', 'DATABASE_URL', 'UPLOADS_DIR', 'AUTH_FILE', 'APP_PASSWORD', 'SESSION_SECRET'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const savedAsyncLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'AsyncLocalStorage');

let directory: string;
let fixture: Fixture | undefined;
let accounts: typeof import('../lib/auth/accounts');
let auth: typeof import('../lib/auth/store');
let authorization: typeof import('../lib/auth/authorization');
let passwords: typeof import('../lib/auth/password');
let vault: typeof import('../lib/storage/vault');
let database: typeof import('../lib/storage/database');
let paths: typeof import('../lib/storage/paths');
let management: typeof import('../lib/storage/access-management');
let access: typeof import('../lib/sync/access');
let service: typeof import('../lib/sync/service');
let jobs: typeof import('../lib/sync/jobs');
let journal: typeof import('../lib/sync/journal');
let cryptoBundle: typeof import('../lib/crypto/bundle');
let primitives: typeof import('../lib/crypto/primitives');
let uploads: typeof import('../lib/uploads');
let prisma: typeof import('../lib/db')['prisma'];
let workStorage: typeof import('next/dist/server/app-render/work-async-storage.external');
let requestStorage: typeof import('next/dist/server/app-render/work-unit-async-storage.external');
let cookies: typeof import('next/dist/server/web/spec-extension/cookies');
let iron: typeof import('iron-session');
let completionRoute: typeof import('../app/api/admin/sync-access/route');
let sessionRegistry: typeof import('../lib/auth/session-registry').sessionRegistry;

interface Installation { name: 'A' | 'B' | 'C'; dir: string; admin: AdminAccount; adminPassword: string }
interface Fixture { installs: [Installation, Installation, Installation]; personId: string; scanId: string }

function setEnvironment(dir: string) {
  process.env.DATA_DIR = dir;
  process.env.DATABASE_URL = `file:${join(dir, 'data.db')}`;
  process.env.UPLOADS_DIR = join(dir, 'uploads');
  process.env.AUTH_FILE = join(dir, 'auth.json');
  process.env.APP_PASSWORD = '';
  process.env.SESSION_SECRET = SESSION_SECRET;
}

async function activate(installation: Pick<Installation, 'dir'>, password?: string) {
  // Both vault and Prisma keep process-global state. Close the previous
  // installation BEFORE changing any path, then reset the new lock state.
  await vault.vaultLock();
  await database.closeDatabase();
  setEnvironment(installation.dir);
  await vault.vaultLock();
  assert.equal(paths.dataDirectory(), installation.dir);
  assert.ok(!relative(installation.dir, paths.activeDatabasePath()).startsWith('..'));
  if (password !== undefined) await vault.vaultUnlock(password);
}

async function session(role: 'user' | 'admin'): Promise<SessionData> {
  const metadata = await auth.readAuth();
  const account = role === 'user' ? metadata.primary! : metadata.admin!;
  return { authenticated: true, role, userId: account.id, authVersion: authorization.accountVersion(account) };
}

function rejectsStatus(status: number) {
  return (error: unknown) => error instanceof Response && error.status === status;
}

async function assertLogin(password: string) {
  const user = await accounts.authenticateAccount('operator', password, vault);
  assert.equal(user.role, 'user');
  return user;
}

async function assertAdmin(installation: Installation) {
  assert.deepEqual((await auth.readAuth()).admin, installation.admin);
  assert.equal(await passwords.verifyPassword(installation.admin.passwordHash, installation.adminPassword), true);
}

async function assertData(phone = 'synthetic-base-phone') {
  const person = await prisma.person.findUniqueOrThrow({ where: { id: fixture!.personId } });
  assert.equal(person.lastName, 'SyntheticSyncAccessSurname');
  assert.equal(person.firstName, 'Synthetic');
  assert.equal(person.phone, phone);
  const scan = await prisma.passportScan.findUniqueOrThrow({ where: { id: fixture!.scanId } });
  assert.equal(scan.personId, person.id);
  assert.equal(scan.sizeBytes, DOCUMENT.length);
  assert.deepEqual(await uploads.readScanFile(scan.storedPath), DOCUMENT);
  return scan;
}

async function assertEncryptedFiles() {
  const scan = await assertData((await prisma.person.findUniqueOrThrow({ where: { id: fixture!.personId } })).phone!);
  const db = await readFile(paths.activeDatabasePath());
  const document = await readFile(join(paths.uploadsDirectory(), scan.storedPath));
  assert.notEqual(db.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(db.includes(Buffer.from('SyntheticSyncAccessSurname')), false);
  assert.equal(document.subarray(0, 5).toString(), 'TDBE1');
  assert.equal(document.includes(DOCUMENT), false);
}

function decisions(job: SyncJob) {
  assert.ok(job.plan.records.every(record => record.conflicts.length === 0 && !record.constraint));
  return Object.fromEntries(job.plan.records.map(record => [record.key, { action: 'accept' as const }]));
}

async function preview(buffer: Buffer, installation: Installation, password?: string) {
  return service.previewSyncBundle(buffer, installation.dir, password);
}

async function apply(job: SyncJob, decision?: AccessDecision) {
  return service.applySyncJob(job.id, job.owner, job.fingerprint, decisions(job), decision);
}

async function validateAccess(job: SyncJob, decision?: AccessDecision) {
  return prisma.$transaction(tx => access.applySyncAccess(job.access, decision, tx));
}

async function credentials() {
  return { auth: await auth.readAuth(), vault: vault.readVault() };
}

async function adminComplete(token: string, proof: string, recovery = false, incomingPassword?: string, caller?: SessionData) {
  const jar = new cookies.ResponseCookies(new Headers());
  const identity = caller ?? await session('admin');
  // Account-service fixtures bypass the HTTP login route, so mint its server ID here.
  if (!identity.sessionId) identity.sessionId = sessionRegistry.register(identity);
  jar.set('tdb_session', await iron.sealData(identity, { password: SESSION_SECRET }));
  const work = { isStaticGeneration: false, route: '/api/admin/sync-access', page: '/api/admin/sync-access/route' } as WorkStore;
  const request = { type: 'request', phase: 'action', cookies: jar, userspaceMutableCookies: jar, mutableCookies: jar } as unknown as RequestStore;
  return workStorage.workAsyncStorage.run(work, () => requestStorage.workUnitAsyncStorage.run(request, () => completionRoute.POST(new Request('http://localhost/api/admin/sync-access', {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({ token, proof, recovery, incomingPassword }),
  }))));
}

function assertNoSecrets(value: unknown, secrets: (string | Buffer)[]) {
  const serialized = Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value);
  assert.equal(/"(?:root|password|localPassword|incomingPassword|proof|recoveryCode)"\s*:/.test(serialized), false);
  for (const secret of secrets) {
    if (Buffer.isBuffer(secret)) {
      if (Buffer.isBuffer(value)) assert.equal(value.includes(secret), false, 'raw root key leaked');
      assert.equal(serialized.includes(secret.toString('hex')), false, 'hex root key leaked');
      assert.equal(serialized.includes(secret.toString('base64')), false, 'base64 root key leaked');
      assert.equal(serialized.includes(JSON.stringify(secret)), false, 'serialized root key leaked');
    } else {
      assert.equal(serialized.includes(secret), false, 'plaintext credential leaked');
    }
  }
}

async function assertNoDiskSecrets(dir: string, secrets: (string | Buffer)[]) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await assertNoDiskSecrets(path, secrets);
    else if (item.name.endsWith('.json')) assertNoSecrets(await readFile(path), secrets);
  }
}

async function encryptLocal(installation: Installation) {
  await activate(installation);
  const prepared = await management.prepareEncryption(installation.admin.id, OLD_PASSWORD);
  await management.enableEncryption(installation.admin.id, OLD_PASSWORD, prepared.token, true);
  await assert.rejects(prisma.person.findMany(), /заблокировано/);
  await vault.vaultUnlock(OLD_PASSWORD);
  await assertData();
  await assertAdmin(installation);
  return prepared;
}

async function sharedEncrypted() {
  const [a, b, c] = fixture!.installs;
  const prepared = await encryptLocal(a);
  const buffer = (await service.exportSyncBundle()).buffer;
  for (const installation of [b, c]) {
    await activate(installation);
    const job = await preview(buffer, installation, OLD_PASSWORD);
    const pending = await apply(job, { choice: 'incoming' });
    assert.equal(pending.access?.status, 'pending');
    assert.equal(pending.access?.requiresAdmin, true);
    assert.equal(pending.complete, false);
    const response = await adminComplete(pending.access!.adminToken!, OLD_PASSWORD, false, OLD_PASSWORD);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    await assertLogin(OLD_PASSWORD);
    const finished = await apply(await preview(buffer, installation, OLD_PASSWORD), { choice: 'incoming' });
    assert.equal(finished.complete, true);
    await assertData();
    await assertAdmin(installation);
  }
  return prepared;
}

describe('real auth/vault/sync-access across three isolated installations', { concurrency: false }, () => {
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tdb-sync-access-integration-'));
    const bootstrap = join(directory, 'bootstrap');
    await mkdir(bootstrap);
    // In particular APP_PASSWORD must be cleared BEFORE the late Prisma import.
    // No .env is loaded and no real auth/database/upload path is ever opened.
    setEnvironment(bootstrap);
    Object.assign(globalThis, { AsyncLocalStorage });
    accounts = await import('../lib/auth/accounts');
    auth = await import('../lib/auth/store');
    authorization = await import('../lib/auth/authorization');
    passwords = await import('../lib/auth/password');
    vault = await import('../lib/storage/vault');
    database = await import('../lib/storage/database');
    paths = await import('../lib/storage/paths');
    management = await import('../lib/storage/access-management');
    access = await import('../lib/sync/access');
    // Register the real implementation; never substitute the sync unit-test stub.
    await import('../lib/storage/sync-access');
    assert.equal(access.hasSyncAccessPostCommit(), true);
    prisma = (await import('../lib/db')).prisma;
    service = await import('../lib/sync/service');
    jobs = await import('../lib/sync/jobs');
    journal = await import('../lib/sync/journal');
    cryptoBundle = await import('../lib/crypto/bundle');
    primitives = await import('../lib/crypto/primitives');
    uploads = await import('../lib/uploads');
    workStorage = await import('next/dist/server/app-render/work-async-storage.external');
    requestStorage = await import('next/dist/server/app-render/work-unit-async-storage.external');
    cookies = await import('next/dist/server/web/spec-extension/cookies');
    iron = await import('iron-session');
    completionRoute = await import('../app/api/admin/sync-access/route');
    sessionRegistry = (await import('../lib/auth/session-registry')).sessionRegistry;
  });

  beforeEach(async () => {
    const root = await mkdtemp(join(directory, 'case-'));
    const installs = ['A', 'B', 'C'].map(name => ({ name, dir: join(root, name), adminPassword: `synthetic-local-admin-${name}-password` })) as Omit<Installation, 'admin'>[];
    for (const installation of installs) await mkdir(installation.dir);
    const completed: Installation[] = [];
    for (const installation of installs) {
      await activate(installation);
      await accounts.createAdmin(installation.adminPassword);
      completed.push({ ...installation, admin: (await auth.readAuth()).admin! });
    }
    const [a, b, c] = completed as Fixture['installs'];
    await activate(a);
    await accounts.createPrimary(await session('admin'), 'operator', OLD_PASSWORD);
    const primary = (await auth.readAuth()).primary!;
    const person = await prisma.person.create({ data: { lastName: 'SyntheticSyncAccessSurname', firstName: 'Synthetic', phone: 'synthetic-base-phone' } });
    const storedPath = `${person.id}/synthetic.pdf`;
    await uploads.writeScanFile(storedPath, DOCUMENT);
    const scan = await prisma.passportScan.create({ data: { personId: person.id, filename: 'synthetic.pdf', storedPath, mimeType: 'application/pdf', sizeBytes: DOCUMENT.length } });
    fixture = { installs: [a, b, c], personId: person.id, scanId: scan.id };
    const baseline = (await service.exportSyncBundle()).buffer;
    const databaseId = (await prisma.databaseMetadata.findUniqueOrThrow({ where: { id: 'main' } })).databaseId;
    const instanceIds = new Set<string>([await journal.getInstanceId()]);
    for (const installation of [b, c]) {
      await activate(installation);
      // An independently stored snapshot of the shared primary identity, while
      // each installation retains its own genuinely Argon2-hashed local admin.
      await auth.updateAuth(metadata => { metadata.primary = structuredClone(primary); });
      const job = await preview(baseline, installation);
      assert.equal(job.accessPreview, null);
      assert.equal((await apply(job)).complete, true);
      jobs.clearOwnerJobs(installation.dir);
      await assertData();
      await assertAdmin(installation);
      assert.equal((await prisma.databaseMetadata.findUniqueOrThrow({ where: { id: 'main' } })).databaseId, databaseId);
      instanceIds.add(await journal.getInstanceId());
    }
    assert.equal(instanceIds.size, 3);
    assert.equal(new Set(completed.map(item => item.admin.id)).size, 3);
    assert.equal(new Set(completed.map(item => item.admin.passwordHash)).size, 3);
    await activate(a);
  });

  afterEach(async () => {
    if (fixture) for (const installation of fixture.installs) jobs.clearOwnerJobs(installation.dir);
    await vault?.vaultLock();
    await database?.closeDatabase();
    fixture = undefined;
  });

  after(async () => {
    try {
      await vault?.vaultLock();
      await database?.closeDatabase();
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      if (savedAsyncLocalStorage) Object.defineProperty(globalThis, 'AsyncLocalStorage', savedAsyncLocalStorage);
      else Reflect.deleteProperty(globalThis, 'AsyncLocalStorage');
    }
  });

  test('plaintext password propagation requires an explicit choice and invalidates only the receiving primary session', async () => {
    const [a, b, c] = fixture!.installs;
    await management.changePrimaryPassword(OLD_PASSWORD, NEW_PASSWORD, false);
    const buffer = (await service.exportSyncBundle()).buffer;
    await activate(b);
    const previousSession = await assertLogin(OLD_PASSWORD);
    const before = await credentials();
    const job = await preview(buffer, b);
    assert.equal(job.accessPreview?.required, true);
    assert.equal(job.accessPreview?.requiresProof, false);
    assert.deepEqual(await prisma.$transaction(tx => access.previewSyncAccess(job.access, tx)), job.accessPreview);
    await assert.rejects(validateAccess(job), /Выберите решение/);
    await assert.rejects(apply(job), /Выберите решение/);
    assert.deepEqual(await credentials(), before);
    const deferred = await apply(job, { choice: 'defer' });
    assert.equal(deferred.complete, false);
    assert.equal(deferred.access?.status, 'deferred');
    assert.deepEqual(await credentials(), before);
    const accepted = await apply(await service.refreshSyncJob(job), { choice: 'incoming' });
    assert.equal(accepted.complete, true);
    assert.equal(accepted.access?.status, 'applied');
    assert.equal(accepted.access?.requiresLogin, true);
    const after = await auth.readAuth();
    assert.ok(after.primary!.version > before.auth.primary!.version);
    assert.throws(() => authorization.authorizeSession(previousSession, after, 'user'), rejectsStatus(401));
    await assert.rejects(assertLogin(OLD_PASSWORD), rejectsStatus(401));
    await assertLogin(NEW_PASSWORD);
    await assertData();
    await assertAdmin(b);
    await activate(c);
    await assertLogin(OLD_PASSWORD);
    await assertData();
    await assertAdmin(c);
    await activate(a);
    await assertLogin(NEW_PASSWORD);
    await assertAdmin(a);
  });

  test('a fresh bundle carrying an ancestor never rolls newer plaintext credentials back', async () => {
    const [a, b, c] = fixture!.installs;
    const stale = (await service.exportSyncBundle()).buffer; // Distinct bundle ID from fixture seeding.
    await management.changePrimaryPassword(OLD_PASSWORD, NEW_PASSWORD, false);
    const current = (await service.exportSyncBundle()).buffer;
    for (const installation of [b, c]) {
      await activate(installation);
      assert.equal((await apply(await preview(current, installation), { choice: 'incoming' })).complete, true);
      await assertLogin(NEW_PASSWORD);
      const before = await credentials();
      const job = await preview(stale, installation);
      assert.equal(job.accessPreview, null);
      const validated = await validateAccess(job, { choice: 'incoming' });
      assert.equal(validated!.status, 'unchanged');
      assert.equal((await access.completeSyncAccess(job.access, { choice: 'incoming' }, validated!)).status, 'unchanged');
      assert.equal((await apply(job, { choice: 'incoming' })).access?.status, 'unchanged');
      assert.deepEqual(await credentials(), before);
      await assert.rejects(assertLogin(OLD_PASSWORD), rejectsStatus(401));
      await assertLogin(NEW_PASSWORD);
      await assertData();
      await assertAdmin(installation);
    }
    await activate(a);
    await assertLogin(NEW_PASSWORD);
  });

  test('concurrent password branches require selection; keep-local resolves both parents and converges on all three installations', async () => {
    const [a, b, c] = fixture!.installs;
    await management.changePrimaryPassword(OLD_PASSWORD, NEW_PASSWORD, false);
    const aRevision = vault.readVault().accessRevision;
    const aBranch = (await service.exportSyncBundle()).buffer;
    await activate(b);
    await management.changePrimaryPassword(OLD_PASSWORD, BRANCH_PASSWORD, false);
    const bRevision = vault.readVault().accessRevision;
    const bBranch = (await service.exportSyncBundle()).buffer;
    const before = await auth.readAuth();
    const currentSession = await assertLogin(BRANCH_PASSWORD);
    const job = await preview(aBranch, b);
    assert.equal(job.accessPreview?.required, true);
    await assert.rejects(validateAccess(job), /Выберите решение/);
    const kept = await apply(job, { choice: 'local' });
    assert.equal(kept.complete, true);
    assert.equal(kept.access?.status, 'applied');
    assert.notEqual(kept.access?.requiresLogin, true);
    assert.deepEqual(await auth.readAuth(), before);
    authorization.authorizeSession(currentSession, await auth.readAuth(), 'user');
    const resolved = vault.readVault();
    assert.notEqual(resolved.accessRevision, bRevision);
    assert.deepEqual(new Set(resolved.accessHistory!.find(node => node.id === resolved.accessRevision)!.parents), new Set([aRevision, bRevision]));
    const resolution = (await service.exportSyncBundle()).buffer;
    assert.equal((await preview(aBranch, b)).accessPreview, null);
    const fingerprints = new Set<string>([cryptoBundle.accessFingerprint({ primary: before.primary, vault: resolved })]);
    for (const installation of [c, a]) {
      await activate(installation);
      assert.equal((await apply(await preview(resolution, installation), { choice: 'incoming' })).complete, true);
      await assertLogin(BRANCH_PASSWORD);
      assert.equal((await preview(aBranch, installation)).accessPreview, null);
      assert.equal((await preview(bBranch, installation)).accessPreview, null);
      fingerprints.add(cryptoBundle.accessFingerprint({ primary: (await auth.readAuth()).primary, vault: vault.readVault() }));
      await assertData();
      await assertAdmin(installation);
    }
    assert.equal(fingerprints.size, 1);
  });

  test('same-root encrypted sync transfers a new password and recovery slot without re-encrypting local documents', async () => {
    const [a, b, c] = fixture!.installs;
    const prepared = await sharedEncrypted();
    await activate(a, OLD_PASSWORD);
    const root = Buffer.from(vault.vaultKey());
    try {
      const stale = (await service.exportSyncBundle()).buffer;
      const rotated = await management.changePrimaryPassword(prepared.recoveryCode, NEW_PASSWORD, true);
      assert.ok(rotated.recoveryCode);
      assert.notEqual(rotated.recoveryCode, prepared.recoveryCode);
      await assertLogin(NEW_PASSWORD);
      const incomingSlots = vault.readVault();
      const buffer = (await service.exportSyncBundle()).buffer;
      for (const installation of [b, c]) {
        await activate(installation, OLD_PASSWORD);
        assert.deepEqual(vault.vaultKey(), root);
        const before = vault.readVault();
        const scan = await assertData();
        const documentBefore = await readFile(join(paths.uploadsDirectory(), scan.storedPath));
        const job = await preview(buffer, installation, NEW_PASSWORD);
        const ephemeral = job.access as TransferAccess;
        assert.deepEqual(ephemeral.root, root);
        assert.equal((await validateAccess(job, { choice: 'incoming' }))!.status, 'applied');
        const report = await apply(job, { choice: 'incoming' }); // No localPassword: roots match.
        assert.equal(report.complete, true);
        assert.equal(report.access?.requiresLogin, true);
        assert.equal(ephemeral.password, undefined);
        assert.equal(ephemeral.root, undefined);
        assert.equal(vault.readVault().generation, before.generation);
        assert.deepEqual(vault.readVault().passwordSlot, incomingSlots.passwordSlot);
        assert.deepEqual(vault.readVault().recoverySlot, incomingSlots.recoverySlot);
        assert.deepEqual(await readFile(join(paths.uploadsDirectory(), scan.storedPath)), documentBefore);
        await assert.rejects(vault.vaultUnlock(OLD_PASSWORD));
        await assert.rejects(assertLogin(OLD_PASSWORD), rejectsStatus(401));
        await assertLogin(NEW_PASSWORD);
        assert.deepEqual(vault.vaultKey(), root);
        assert.throws(() => primitives.unwrapRecovery(vault.readVault().recoverySlot!, prepared.recoveryCode));
        const recovered = primitives.unwrapRecovery(vault.readVault().recoverySlot!, rotated.recoveryCode!);
        assert.deepEqual(recovered, root); recovered.fill(0);
        const current = await credentials();
        const staleJob = await preview(stale, installation, OLD_PASSWORD);
        assert.equal(staleJob.accessPreview, null);
        assert.equal((await apply(staleJob, { choice: 'incoming' })).access?.status, 'unchanged');
        assert.deepEqual(await credentials(), current);
        await assertData();
        await assertEncryptedFiles();
        await assertAdmin(installation);
      }
    } finally { root.fill(0); }
  });

  test('key-slot field order cannot change access identity or invalidate history after encryption and recovery rotation', async () => {
    const [a] = fixture!.installs;
    const prepared = await encryptLocal(a);
    const current = await credentials();
    const reorder = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;
    const reordered = { ...current.vault, passwordSlot: reorder(current.vault.passwordSlot!), recoverySlot: reorder(current.vault.recoverySlot!) };
    const fingerprint = cryptoBundle.accessFingerprint({ primary: current.auth.primary, vault: current.vault });
    assert.equal(cryptoBundle.accessFingerprint({ primary: current.auth.primary, vault: reordered }), fingerprint, 'identical wrapped keys must have the same fingerprint regardless of JSON field order');
    assert.equal(current.vault.accessHistory!.find(node => node.id === current.vault.accessRevision)!.fingerprint, fingerprint, 'enableEncryption must persist a history head matching the schema-parsed credentials');
    await management.changePrimaryPassword(prepared.recoveryCode, NEW_PASSWORD, true);
    const rotated = await credentials();
    assert.equal(rotated.vault.accessHistory!.find(node => node.id === rotated.vault.accessRevision)!.fingerprint, cryptoBundle.accessFingerprint({ primary: rotated.auth.primary, vault: rotated.vault }), 'recovery rotation must preserve a valid access-history head');
    await assertLogin(NEW_PASSWORD);
    await assertData();
    await assertAdmin(a);
  });

  test('different encrypted roots require the current local password before rekeying a generation', async () => {
    const [a, b, c] = fixture!.installs;
    const remote = await encryptLocal(a);
    const incomingRoot = Buffer.from(vault.vaultKey());
    const buffer = (await service.exportSyncBundle()).buffer;
    await encryptLocal(b);
    const localRoot = Buffer.from(vault.vaultKey());
    try {
      assert.equal(localRoot.equals(incomingRoot), false);
      const before = await credentials();
      const oldGeneration = before.vault.generation!;
      const job = await preview(buffer, b, OLD_PASSWORD);
      assert.equal(job.accessPreview?.requiresProof, true);
      await assert.rejects(validateAccess(job, { choice: 'incoming' }), /текущий пароль локальной базы/);
      await assert.rejects(apply(job, { choice: 'incoming', localPassword: WRONG_PASSWORD }), /текущий пароль локальной базы/);
      assert.deepEqual(await credentials(), before);
      assert.deepEqual(vault.vaultKey(), localRoot);
      await assertData();
      const report = await apply(job, { choice: 'incoming', localPassword: OLD_PASSWORD });
      assert.equal(report.complete, true);
      assert.equal(report.access?.requiresLogin, true);
      assert.notEqual(vault.readVault().generation, oldGeneration);
      assert.equal(existsSync(join(b.dir, 'vaults', oldGeneration)), false);
      assert.equal(existsSync(join(b.dir, 'storage-transition.json')), false);
      assert.equal(existsSync(join(b.dir, 'credential-transition.json')), false);
      await assertLogin(OLD_PASSWORD);
      assert.deepEqual(vault.vaultKey(), incomingRoot);
      const recovered = primitives.unwrapRecovery(vault.readVault().recoverySlot!, remote.recoveryCode);
      assert.deepEqual(recovered, incomingRoot); recovered.fill(0);
      await assertData();
      await assertEncryptedFiles();
      await assertAdmin(b);
      await activate(c);
      assert.equal(vault.vaultEncryptionEnabled(), false);
      await assertLogin(OLD_PASSWORD);
      await assertData();
      await assertAdmin(c);
    } finally { incomingRoot.fill(0); localRoot.fill(0); }
  });

  test('a primary user leaves a mode change pending; admin completes it after restart with current and incoming passwords', async () => {
    const [a, b, c] = fixture!.installs;
    const prepared = await encryptLocal(a);
    await management.changePrimaryPassword(OLD_PASSWORD, NEW_PASSWORD, false);
    await assertLogin(NEW_PASSWORD);
    await prisma.person.update({ where: { id: fixture!.personId }, data: { phone: 'synthetic-incoming-phone' } });
    const root = Buffer.from(vault.vaultKey());
    try {
      const buffer = (await service.exportSyncBundle()).buffer;
      await activate(b);
      const primarySession = await assertLogin(OLD_PASSWORD);
      const before = await credentials();
      const job = await preview(buffer, b, NEW_PASSWORD);
      const pending = await apply(job, { choice: 'incoming' });
      assert.equal(pending.complete, false);
      assert.equal(pending.access?.status, 'pending');
      assert.equal(pending.access?.requiresAdmin, true);
      assert.notEqual(pending.access?.requiresLogin, true);
      assert.equal(vault.vaultEncryptionEnabled(), false);
      assert.deepEqual(await credentials(), before);
      await assertData('synthetic-incoming-phone');
      const token = pending.access!.adminToken!;
      const descriptorPath = join(b.dir, 'pending-access', `${token}.json`);
      assertNoSecrets(await readFile(descriptorPath), [OLD_PASSWORD, NEW_PASSWORD, root, prepared.recoveryCode]);
      assert.equal((await adminComplete(token, OLD_PASSWORD, false, NEW_PASSWORD, primarySession)).status, 403);
      assert.deepEqual(await credentials(), before);
      jobs.clearOwnerJobs(b.dir); // Durable descriptor must work without the original in-memory job.
      await activate(c);
      await assertLogin(OLD_PASSWORD);
      await assertData();
      await activate(b);
      const adminSession = await accounts.authenticateAccount('admin', b.adminPassword, vault);
      for (const [proof, incomingPassword] of [[WRONG_PASSWORD, NEW_PASSWORD], [OLD_PASSWORD, undefined], [OLD_PASSWORD, WRONG_PASSWORD]] as const) {
        assert.notEqual((await adminComplete(token, proof, false, incomingPassword, adminSession)).status, 200);
        assert.equal(existsSync(descriptorPath), true);
        assert.deepEqual(await credentials(), before);
        await assertData('synthetic-incoming-phone');
      }
      const completed = await adminComplete(token, OLD_PASSWORD, false, NEW_PASSWORD, adminSession);
      assert.equal(completed.status, 200, JSON.stringify(await completed.clone().json()));
      assert.equal((await completed.json() as AccessResult).status, 'applied');
      assert.equal(existsSync(descriptorPath), false);
      assert.equal(existsSync(join(b.dir, 'data.db')), false);
      assert.deepEqual(await readdir(join(b.dir, 'uploads')), []);
      assert.equal(existsSync(join(b.dir, 'storage-transition.json')), false);
      assert.equal(existsSync(join(b.dir, 'credential-transition.json')), false);
      assert.equal(vault.vaultEncryptionEnabled(), true);
      await assert.rejects(prisma.person.findMany(), /заблокировано/);
      authorization.authorizeSession(adminSession, await auth.readAuth(), 'admin');
      await assert.rejects(assertLogin(OLD_PASSWORD), rejectsStatus(401));
      await assertLogin(NEW_PASSWORD);
      assert.deepEqual(vault.vaultKey(), root);
      await assertData('synthetic-incoming-phone');
      await assertEncryptedFiles();
      await assertAdmin(b);
      const retried = await preview(buffer, b, NEW_PASSWORD);
      assert.equal(retried.accessPreview, null);
      const receipt = await apply(retried, { choice: 'incoming' });
      assert.equal(receipt.complete, true);
      assert.equal(receipt.applied, pending.applied);
      assert.equal((await apply(retried, { choice: 'incoming' })).replayed, true);
    } finally { root.fill(0); }
  });

  test('admin can finish encrypted-to-plaintext mode changes with either the current password or the recovery code', async () => {
    const [a, b, c] = fixture!.installs;
    const prepared = await sharedEncrypted();
    await activate(a, OLD_PASSWORD);
    await management.disableEncryption(OLD_PASSWORD, false);
    await management.changePrimaryPassword(OLD_PASSWORD, NEW_PASSWORD, false);
    const buffer = (await service.exportSyncBundle()).buffer;
    for (const [installation, recovery, proof] of [[b, false, OLD_PASSWORD], [c, true, prepared.recoveryCode]] as const) {
      await activate(installation, OLD_PASSWORD);
      const before = await credentials();
      const oldGeneration = before.vault.generation!;
      const job = await preview(buffer, installation);
      const pending = await apply(job, { choice: 'incoming' });
      assert.equal(pending.complete, false);
      assert.equal(pending.access?.requiresAdmin, true);
      assert.deepEqual(await credentials(), before);
      const token = pending.access!.adminToken!;
      const bad = recovery ? '0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000' : WRONG_PASSWORD;
      assert.notEqual((await adminComplete(token, bad, recovery)).status, 200);
      assert.deepEqual(await credentials(), before);
      const response = await adminComplete(token, proof, recovery);
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const next = vault.readVault();
      assert.equal(next.enabled, false);
      assert.equal(next.passwordSlot, undefined);
      assert.equal(next.recoverySlot, undefined);
      assert.notEqual(next.generation, oldGeneration);
      assert.equal(existsSync(join(installation.dir, 'vaults', oldGeneration)), false);
      await assert.rejects(assertLogin(OLD_PASSWORD), rejectsStatus(401));
      await assertLogin(NEW_PASSWORD);
      const scan = await assertData();
      assert.equal((await readFile(paths.activeDatabasePath())).subarray(0, 16).toString(), 'SQLite format 3\0');
      assert.deepEqual(await readFile(join(paths.uploadsDirectory(), scan.storedPath)), DOCUMENT);
      await assertAdmin(installation);
    }
  });

  test('a plaintext installation cannot bypass its current password by claiming a recovery proof', async () => {
    const [a, b] = fixture!.installs;
    const initial = await credentials();
    const ancestor = cryptoBundle.accessFingerprint({ primary: initial.auth.primary, vault: initial.vault });
    await encryptLocal(a);
    const source = await credentials();
    const revision = randomUUID();
    // A directly constructed, valid causal descriptor isolates proof validation
    // from the separate generated-history/key-slot-order regression above. The
    // password hash, encrypted SQLite, attachments and both slots are real.
    const incoming: TransferAccess = {
      primary: source.auth.primary, root: Buffer.from(vault.vaultKey()), password: OLD_PASSWORD,
      vault: { ...source.vault, accessRevision: revision, accessHistory: [
        { id: ancestor, parents: [], fingerprint: ancestor },
        { id: revision, parents: [ancestor], fingerprint: cryptoBundle.accessFingerprint({ primary: source.auth.primary, vault: source.vault }) },
      ] },
    };
    try {
      await activate(b);
      const before = await credentials();
      assert.equal((await prisma.$transaction(tx => access.previewSyncAccess(incoming, tx)))?.required, true);
      const validated = await prisma.$transaction(tx => access.applySyncAccess(incoming, { choice: 'incoming' }, tx));
      const pending = await access.completeSyncAccess(incoming, { choice: 'incoming' }, validated!);
      assert.equal(pending.status, 'pending');
      assert.equal(pending.requiresAdmin, true);
      assert.deepEqual(await credentials(), before);
      const token = pending.adminToken!;
      const response = await adminComplete(token, 'not-a-recovery-code', true, OLD_PASSWORD);
      assert.notEqual(response.status, 200, 'plaintext vault has no recovery slot: current-password proof must remain mandatory');
      assert.deepEqual(await credentials(), before);
      assert.equal(existsSync(join(b.dir, 'pending-access', `${token}.json`)), true);
      await assertData();
      await assertAdmin(b);
    } finally { jobs.clearJobAccess(incoming); }
  });

  test('bundle headers, public access, pending descriptors and durable receipts never serialize plaintext passwords or root keys', async () => {
    const [a, b] = fixture!.installs;
    const prepared = await encryptLocal(a);
    const root = Buffer.from(vault.vaultKey());
    try {
      const buffer = (await service.exportSyncBundle()).buffer;
      const header = JSON.parse(buffer.subarray(12, 12 + buffer.readUInt32BE(8)).toString('utf8'));
      const secrets = [OLD_PASSWORD, a.adminPassword, b.adminPassword, prepared.recoveryCode, prepared.recoveryCode.replaceAll('-', ''), root];
      assertNoSecrets(buffer, secrets);
      assertNoSecrets(header, secrets);
      assert.deepEqual(Object.keys(header.access).sort(), ['primary', 'vault']);
      assert.equal(header.access.vault.generation, undefined);
      assert.equal(header.access.admin, undefined);
      await activate(b);
      const job = await preview(buffer, b, OLD_PASSWORD);
      const ephemeral = job.access as TransferAccess;
      assert.equal(ephemeral.password, OLD_PASSWORD);
      assert.deepEqual(ephemeral.root, root);
      const rootReference = ephemeral.root!;
      assertNoSecrets(jobs.publicJob(job), secrets);
      const report = await apply(job, { choice: 'incoming' });
      assertNoSecrets(report, secrets);
      for (const receipt of await prisma.syncReceipt.findMany()) assertNoSecrets(JSON.parse(receipt.result), secrets);
      await assertNoDiskSecrets(b.dir, secrets);
      jobs.clearOwnerJobs(b.dir);
      assert.deepEqual(rootReference, Buffer.alloc(32));
      assert.equal(ephemeral.root, undefined);
      assert.equal(ephemeral.password, undefined);
      await assertAdmin(b);
    } finally { root.fill(0); }
  });

  test('a failed conversion callback preserves source credentials and documents and removes the staged generation', async () => {
    const [a, b] = fixture!.installs;
    await encryptLocal(a);
    const buffer = (await service.exportSyncBundle()).buffer;
    const decoded = await cryptoBundle.decodeVaultBundle(buffer, OLD_PASSWORD);
    const incoming = decoded.access!;
    try {
      await encryptLocal(b);
      const before = await credentials();
      const sourceDb = paths.activeDatabasePath();
      const scan = await assertData();
      const sourceDocument = await readFile(join(paths.uploadsDirectory(), scan.storedPath));
      const root = Buffer.from(vault.vaultKey());
      try {
        const credentialTransaction = await import('../lib/storage/credential-transaction');
        const target = { root: incoming.root!, passwordSlot: incoming.vault.passwordSlot!, recoverySlot: incoming.vault.recoverySlot!, accessRevision: incoming.vault.accessRevision };
        await assert.rejects(vault.convertVault(true, OLD_PASSWORD, false, target, next => {
          credentialTransaction.commitCredentialFiles({ ...before.auth, primary: { ...before.auth.primary!, id: before.auth.admin!.id } }, next);
        }));
        assert.deepEqual(await credentials(), before, 'invalid primary/admin identity must fail before committing either credential file');
        assert.equal(existsSync(join(b.dir, 'credential-transition.json')), false);
        const failedCommit = new Error('synthetic credential commit failure');
        await assert.rejects(vault.convertVault(true, OLD_PASSWORD, false, target, () => { throw failedCommit; }), error => error === failedCommit);
        assert.deepEqual(await credentials(), before);
        assert.equal(paths.activeDatabasePath(), sourceDb);
        assert.deepEqual(vault.vaultKey(), root);
        assert.deepEqual(await readdir(join(b.dir, 'vaults')), [before.vault.generation!]);
        assert.equal(existsSync(join(b.dir, 'storage-transition.json')), false);
        assert.equal(existsSync(join(b.dir, 'credential-transition.json')), false);
        assert.deepEqual(await readFile(join(paths.uploadsDirectory(), scan.storedPath)), sourceDocument);
        await assertLogin(OLD_PASSWORD);
        await assertData();
        await assertAdmin(b);
      } finally { root.fill(0); }
    } finally { jobs.clearJobAccess(incoming); decoded.payload.fill(0); }
  });

  test('durable credential and generation markers recover a vault switch interrupted before the auth-file write', async () => {
    const [a, b, c] = fixture!.installs;
    const before = await credentials();
    const prepared = await encryptLocal(a);
    const committed = await credentials();
    const root = Buffer.from(vault.vaultKey());
    try {
      await vault.vaultLock();
      await database.closeDatabase();
      const { atomicJson } = await import('../lib/storage/atomic-files');
      const credentialMarker = join(a.dir, 'credential-transition.json');
      const generationMarker = join(a.dir, 'storage-transition.json');
      // Recreate the durable state of a crash after vault.json was switched but
      // before auth.json and the marker cleanup completed. Only temp fixtures
      // are written, with genuine hashes, wrapped keys and encrypted files.
      atomicJson(credentialMarker, { format: 1, auth: committed.auth, vault: committed.vault });
      atomicJson(join(a.dir, 'auth.json'), before.auth);
      atomicJson(generationMarker, { format: 1, source: null, target: committed.vault.generation });
      assert.equal(JSON.parse((await readFile(join(a.dir, 'auth.json'))).toString()).primary.version, before.auth.primary!.version);
      assertNoSecrets(await readFile(credentialMarker), [OLD_PASSWORD, prepared.recoveryCode, root]);
      assertNoSecrets(await readFile(generationMarker), [OLD_PASSWORD, prepared.recoveryCode, root]);
      assert.deepEqual(await auth.readAuth(), committed.auth);
      assert.deepEqual(vault.readVault(), committed.vault);
      assert.equal(existsSync(credentialMarker), false);
      assert.equal(existsSync(generationMarker), false);
      assert.equal(existsSync(join(a.dir, 'data.db')), false);
      assert.deepEqual(await readdir(join(a.dir, 'uploads')), []);
      await assert.rejects(prisma.person.findMany(), /заблокировано/);
      await assertLogin(OLD_PASSWORD);
      assert.deepEqual(vault.vaultKey(), root);
      await assertData();
      await assertEncryptedFiles();
      await assertAdmin(a);
      for (const installation of [b, c]) {
        await activate(installation);
        assert.equal(vault.vaultEncryptionEnabled(), false);
        await assertLogin(OLD_PASSWORD);
        await assertData();
        await assertAdmin(installation);
      }
    } finally { root.fill(0); }
  });
});
