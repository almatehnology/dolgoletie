import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import unzipper from 'unzipper';
import type { RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external';
import type { WorkStore } from 'next/dist/server/app-render/work-async-storage.external';
import type { SessionData } from '../lib/auth/types';

async function zipEntries(buffer: Buffer) {
  const zip = await unzipper.Open.buffer(buffer);
  const entries = new Map<string, Buffer>();
  for (const entry of zip.files) if (entry.type === 'File') entries.set(entry.path, await entry.buffer());
  return entries;
}

test('legacy exports and reset respect unlocked roles, encryption and retained sync originals', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tdb-legacy-export-'));
  const secret = 'legacy-export-test-session-secret-32-characters';
  const password = 'synthetic-primary-password';
  process.env.DATA_DIR = directory;
  process.env.DATABASE_URL = `file:${join(directory, 'data.db')}`;
  process.env.UPLOADS_DIR = join(directory, 'uploads');
  process.env.AUTH_FILE = join(directory, 'auth.json');
  process.env.APP_PASSWORD = '';
  process.env.SESSION_SECRET = secret;
  Object.assign(globalThis, { AsyncLocalStorage });

  const { prisma } = await import('../lib/db');
  const { writeScanFile, readScanFile } = await import('../lib/uploads');
  const { uploadsDirectory } = await import('../lib/storage/paths');
  const { createAdmin, createPrimary } = await import('../lib/auth/accounts');
  const { readAuth } = await import('../lib/auth/store');
  const { accountVersion } = await import('../lib/auth/authorization');
  const { withoutJournal } = await import('../lib/sync/journal');
  const { prepareEncryption, enableEncryption } = await import('../lib/storage/access-management');
  const vault = await import('../lib/storage/vault');
  const { decodeVaultBundle } = await import('../lib/crypto/bundle');
  const { withAuthOperation } = await import('../lib/auth/mutex');
  const { exportSyncBundle } = await import('../lib/sync/service');
  const { parseBundle } = await import('../lib/sync/bundle');
  const workStorage = await import('next/dist/server/app-render/work-async-storage.external');
  const requestStorage = await import('next/dist/server/app-render/work-unit-async-storage.external');
  const { ResponseCookies } = await import('next/dist/server/web/spec-extension/cookies');
  const { sealData } = await import('iron-session');
  const { NextRequest } = await import('next/server');
  const backupRoute = await import('../app/api/export/route');
  const personRoute = await import('../app/api/people/[id]/export/route');
  const eventRoute = await import('../app/api/events/[id]/export/route');
  const resetRoute = await import('../app/api/reset/route');

  async function sessionFor(role: 'user' | 'admin'): Promise<SessionData> {
    const auth = await readAuth();
    const account = role === 'user' ? auth.primary! : auth.admin!;
    return { authenticated: true, role, userId: account.id, authVersion: accountVersion(account) };
  }
  async function context<T>(session: SessionData, task: () => Promise<T>) {
    const jar = new ResponseCookies(new Headers());
    jar.set('tdb_session', await sealData(session, { password: secret }));
    const work = { isStaticGeneration: false, route: '/api/export', page: '/api/export/route' } as WorkStore;
    const request = { type: 'request', phase: 'action', cookies: jar, userspaceMutableCookies: jar, mutableCookies: jar } as unknown as RequestStore;
    return workStorage.workAsyncStorage.run(work, () => requestStorage.workUnitAsyncStorage.run(request, task));
  }
  const backup = (scope = 'full') => backupRoute.GET(new NextRequest(`http://localhost/api/export?scope=${scope}`));
  const reset = (confirm = 'ОЧИСТИТЬ') => resetRoute.POST(new NextRequest('http://localhost/api/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }),
  }));

  try {
    await createAdmin('synthetic-admin-password');
    const admin = (await readAuth()).admin!;
    await createPrimary(await sessionFor('admin'), 'operator', password);
    const person = await prisma.person.create({ data: {
      lastName: 'ЗащищённаяФамилия', firstName: 'Анна', birthDate: '1984-02-29', passportNumber: '0012 000034',
    } });
    const event = await prisma.event.create({ data: {
      title: 'Частная поездка', location: 'Москва', startDate: new Date('2026-10-11'), endDate: new Date('2026-10-11'),
      excursions: { create: { name: 'Музей', cost: '100' } },
    } });
    await prisma.participation.create({ data: { personId: person.id, eventId: event.id } });
    const original = Buffer.from('%PDF-1.4\nprivate passport original\n%%EOF');
    const thumb = Buffer.from('synthetic private thumbnail');
    const path = `${person.id}/document.pdf`, thumbPath = `${person.id}/document.thumb.webp`;
    await writeScanFile(path, original);
    await writeScanFile(thumbPath, thumb);
    const scan = await prisma.passportScan.create({ data: {
      personId: person.id, storedPath: path, thumbPath, filename: 'паспорт.pdf', mimeType: 'application/pdf', sizeBytes: original.length,
    } });
    const personExport = () => personRoute.GET(new NextRequest('http://localhost/api/people/export'), { params: Promise.resolve({ id: person.id }) });
    const eventExport = () => eventRoute.GET(new NextRequest('http://localhost/api/events/export'), { params: Promise.resolve({ id: event.id }) });
    const endpoints = [backup, personExport, eventExport, reset];

    await t.test('anonymous, admin and stale sessions cannot export or reset', async () => {
      for (const [session, status] of [
        [{}, 401], [await sessionFor('admin'), 403], [{ ...await sessionFor('user'), authVersion: 'stale' }, 401],
      ] as [SessionData, number][]) {
        for (const endpoint of endpoints) assert.equal((await context(session, () => endpoint())).status, status);
      }
      assert.equal(await prisma.person.count(), 1);
    });

    await t.test('plain legacy ZIP scopes and JSON remain readable with birthDate, IDs, originals and thumbnails', async () => {
      for (const scope of ['full', 'people', 'events']) {
        const response = await context(await sessionFor('user'), () => backup(scope));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Type'), 'application/zip');
        assert.match(response.headers.get('Content-Disposition')!, /\.zip$/);
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
        const entries = await zipEntries(Buffer.from(await response.arrayBuffer()));
        const manifest = JSON.parse(entries.get('manifest.json')!.toString());
        assert.equal(manifest.version, 1);
        assert.equal(manifest.scope, scope);
        assert.deepEqual(manifest.counts, { people: scope === 'events' ? 0 : 1, events: scope === 'people' ? 0 : 1, participations: scope === 'full' ? 1 : 0, scans: scope === 'events' ? 0 : 1 });
        if (scope !== 'events') {
          assert.deepEqual(entries.get(`uploads/${path}`), original);
          assert.deepEqual(entries.get(`uploads/${thumbPath}`), thumb);
          assert.equal(JSON.parse(entries.get('people.json')!.toString())[0].birthDate, '1984-02-29');
        } else assert.equal([...entries.keys()].some((key) => key.startsWith('uploads/')), false);
      }
      const personResponse = await context(await sessionFor('user'), personExport);
      assert.equal(personResponse.status, 200);
      assert.equal((await personResponse.json()).data.birthDate, '1984-02-29');
      const eventResponse = await context(await sessionFor('user'), eventExport);
      assert.equal(eventResponse.status, 200);
      assert.equal((await eventResponse.json()).data.excursions[0].id, (await prisma.excursion.findFirstOrThrow()).id);
    });

    await t.test('missing originals fail the backup instead of silently producing incomplete ZIP', async () => {
      const missing = await withoutJournal(() => prisma.passportScan.create({ data: {
        personId: person.id, storedPath: `${person.id}/missing.pdf`, filename: 'missing.pdf', mimeType: 'application/pdf', sizeBytes: 10,
      } }));
      try {
        const response = await context(await sessionFor('user'), backup);
        assert.equal(response.status, 500);
        assert.equal((await response.json()).error.code, 'EXPORT_FAILED');
      } finally { await withoutJournal(() => prisma.passportScan.delete({ where: { id: missing.id } })); }
    });

    await t.test('encrypted backup has no open PII, decrypts to legacy ZIP, and JSON endpoints refuse export', async () => {
      const prepared = await prepareEncryption(admin.id, password);
      await withAuthOperation(() => enableEncryption(admin.id, password, prepared.token, true));
      const lockedSession = await sessionFor('user');
      for (const endpoint of endpoints) assert.equal((await context(lockedSession, () => endpoint())).status, 423);
      await vault.vaultUnlock(password);
      assert.equal((await readFile(join(uploadsDirectory(), path))).subarray(0, 5).toString(), 'TDBE1');
      for (const scope of ['full', 'people', 'events']) {
        const response = await context(await sessionFor('user'), () => backup(scope));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
        assert.match(response.headers.get('Content-Disposition')!, /\.tdbbackup$/);
        const sealed = Buffer.from(await response.arrayBuffer());
        assert.equal(sealed.subarray(0, 8).toString(), 'TDBSYNC1');
        assert.equal(sealed.includes(Buffer.from(person.lastName)), false);
        assert.equal(sealed.includes(original), false);
        await assert.rejects(decodeVaultBundle(sealed, 'incorrect-password'));
        const decoded = await decodeVaultBundle(sealed, password);
        const entries = await zipEntries(decoded.payload);
        decoded.access?.root?.fill(0);
        assert.equal(JSON.parse(entries.get('manifest.json')!.toString()).scope, scope);
        if (scope !== 'events') {
          assert.deepEqual(entries.get(`uploads/${path}`), original);
          assert.deepEqual(entries.get(`uploads/${thumbPath}`), thumb);
        }
      }
      for (const endpoint of [personExport, eventExport]) {
        const response = await context(await sessionFor('user'), endpoint);
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.error.code, 'LEGACY_EXPORT_DISABLED');
        assert.match(body.error.message, /PDF\/XLSX/);
        assert.equal(JSON.stringify(body).includes(person.lastName), false);
      }
    });

    await t.test('reset requires confirmation, records deletions and preserves history, receipts and attachment objects', async () => {
      const hash = createHash('sha256').update(original).digest('hex');
      const receipt = await prisma.syncReceipt.create({ data: { id: `sync-attachment:${hash}`, result: JSON.stringify({ sha256: hash, path, mimeType: 'application/pdf', bytes: original.length }) } });
      const before = await prisma.changeOperation.count();
      assert.equal((await context(await sessionFor('user'), () => reset('не подтверждено'))).status, 400);
      assert.equal(await prisma.person.count(), 1);
      const response = await context(await sessionFor('user'), reset);
      assert.equal(response.status, 200);
      const counts = await Promise.all([prisma.person.count(), prisma.event.count(), prisma.excursion.count(), prisma.participation.count(), prisma.passportScan.count()]);
      assert.deepEqual(counts, [0, 0, 0, 0, 0]);
      assert.deepEqual(await readScanFile(path), original);
      assert.deepEqual(await readScanFile(thumbPath), thumb);
      assert.equal((await prisma.syncReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).result, receipt.result);
      assert.ok(await prisma.changeOperation.count() > before);
      const deletion = await prisma.changeOperation.findFirstOrThrow({ where: { entity: 'PassportScan', entityId: scan.id, after: null } });
      assert.equal(JSON.parse(deletion.before!).storedPath, path);
      const sync = await exportSyncBundle();
      const decoded = await decodeVaultBundle(sync.buffer, password);
      const bundle = await parseBundle(decoded.payload);
      decoded.access?.root?.fill(0);
      assert.deepEqual(bundle.files.get(hash), original);
      assert.equal(bundle.data.snapshots.PassportScan.length, 0);
      assert.ok(bundle.data.operations.some((op) => op.entityId === scan.id && op.after === null));
    });
  } finally {
    await vault.vaultLock();
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
