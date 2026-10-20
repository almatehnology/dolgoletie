import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkStore } from 'next/dist/server/app-render/work-async-storage.external';
import type { RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external';
import type { ArchiveRequest } from '../lib/archive/model';
import type { AuthMetadata, SessionData } from '../lib/auth/types';
import { archiveRequestSchema } from '../lib/archive/model';
import type { Decisions } from '../lib/sync/types';
import { buildBundle, parseBundle } from '../lib/sync/bundle';
import { buildMergePlan } from '../lib/sync/merge';

let directory: string;
let prisma: typeof import('../lib/db')['prisma'];
let journal: typeof import('../lib/sync/journal');
let route: typeof import('../app/api/archive/route');
let service: typeof import('../lib/archive/service');
let sync: typeof import('../lib/sync/service');
let state: typeof import('../lib/sync/state');
let work: typeof import('next/dist/server/app-render/work-async-storage.external');
let requests: typeof import('next/dist/server/app-render/work-unit-async-storage.external');
let cookies: typeof import('next/dist/server/web/spec-extension/cookies');
let user: string, admin: string, anonymous: string;
const date = new Date('2026-10-01T00:00:00Z');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tdb-archive-'));
  process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
  process.env.DATA_DIR = directory;
  process.env.AUTH_FILE = join(directory, 'auth.json');
  process.env.UPLOADS_DIR = join(directory, 'uploads');
  process.env.SESSION_SECRET = 'synthetic-archive-session-secret-over-32-characters';
  Object.assign(globalThis, { AsyncLocalStorage });
  ({ prisma } = await import('../lib/db'));
  journal = await import('../lib/sync/journal');
  route = await import('../app/api/archive/route');
  service = await import('../lib/archive/service');
  sync = await import('../lib/sync/service');
  state = await import('../lib/sync/state');
  work = await import('next/dist/server/app-render/work-async-storage.external');
  requests = await import('next/dist/server/app-render/work-unit-async-storage.external');
  cookies = await import('next/dist/server/web/spec-extension/cookies');
  const auth = await import('../lib/auth/store');
  const hash = await auth.hashPassword('synthetic-password');
  const metadata = { version: 1 as const, admin: { id: 'admin', username: 'admin', passwordHash: hash }, primary: { id: 'user', username: 'operator', passwordHash: hash, version: 1 } } satisfies AuthMetadata;
  await auth.updateAuth(() => metadata);
  const { sealData } = await import('iron-session');
  const { accountVersion } = await import('../lib/auth/authorization');
  const options = { password: process.env.SESSION_SECRET };
  user = await sealData({ authenticated: true, userId: 'user', role: 'user', authVersion: 1 }, options);
  admin = await sealData({ authenticated: true, userId: 'admin', role: 'admin', authVersion: accountVersion(metadata.admin) }, options);
  anonymous = await sealData({}, options);
  const { registerSyncAccessIntegration } = await import('../lib/sync/access');
  registerSyncAccessIntegration({ preview: async () => null, apply: async () => ({ status: 'unchanged' }) });
});
beforeEach(async () => {
  await journal.withoutJournal(() => prisma.$transaction(async (tx) => {
    await tx.person.deleteMany(); await tx.event.deleteMany();
    await tx.changeOperation.deleteMany(); await tx.syncReceipt.deleteMany();
  }));
});
after(async () => {
  await prisma?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function call(body: unknown, cookie = user, raw = false) {
  // Match the active-session registry introduced by concurrent auth work.
  const { unsealData, sealData } = await import('iron-session');
  const options = { password: process.env.SESSION_SECRET! };
  const session = await unsealData<SessionData>(cookie, options);
  if (session.authenticated) {
    const { sessionRegistry } = await import('../lib/auth/session-registry');
    session.sessionId = sessionRegistry.register(session);
    cookie = await sealData(session, options);
  }
  const jar = new cookies.ResponseCookies(new Headers()); jar.set('tdb_session', cookie);
  const workStore = { isStaticGeneration: false, route: '/api/archive', page: '/api/archive/route' } as WorkStore;
  const requestStore = { type: 'request', phase: 'action', cookies: jar, userspaceMutableCookies: jar, mutableCookies: jar } as unknown as RequestStore;
  const request = new Request('http://localhost/api/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? String(body) : JSON.stringify(body) });
  return work.workAsyncStorage.run(workStore, () => requests.workUnitAsyncStorage.run(requestStore, () => route.POST(request)));
}
const input = (entity: ArchiveRequest['entity'], action: ArchiveRequest['action'], ids: string[]): ArchiveRequest => ({ entity, action, ids, confirm: true });
async function fixture() {
  await prisma.$transaction(async (tx) => {
    await tx.person.createMany({ data: ['p1', 'p2', 'active-person', 'unselected-person'].map((id) => ({ id, firstName: 'Имя', lastName: id, deletedAt: id === 'active-person' ? null : date })) });
    await tx.event.createMany({ data: ['e1', 'e2', 'active-event', 'unselected-event'].map((id) => ({ id, title: id, location: 'Место', startDate: date, endDate: date, deletedAt: id === 'active-event' ? null : date })) });
    await tx.participation.createMany({ data: [{ id: 'part-person', personId: 'p1', eventId: 'active-event' }, { id: 'part-event', personId: 'active-person', eventId: 'e1' }] });
    await tx.excursion.create({ data: { id: 'excursion', eventId: 'e1', name: 'Маршрут' } });
    const { writeScanFile } = await import('../lib/uploads');
    await writeScanFile('p1/original.pdf', pdf);
    await tx.passportScan.create({ data: { id: 'scan', personId: 'p1', filename: 'original.pdf', storedPath: 'p1/original.pdf', mimeType: 'application/pdf', sizeBytes: pdf.length } });
  });
}
const capture = () => journal.withoutJournal(() => prisma.$transaction((tx) => state.captureState(tx)));

test('archive API rejects anonymous/admin sessions and malformed or unconfirmed batches before writes', async () => {
  await fixture();
  const count = await prisma.changeOperation.count();
  for (const [cookie, status] of [[anonymous, 401], [admin, 403]] as const) {
    assert.equal((await call(input('people', 'delete', ['p1']), cookie)).status, status);
  }
  const valid = input('people', 'restore', ['p1']);
  for (const body of [{ ...valid, confirm: false }, { ...valid, confirm: undefined }, { ...valid, entity: 'scans' }, { ...valid, action: 'archive' }, { ...valid, ids: [] }, { ...valid, ids: ['p1', 'p1'] }, { ...valid, ids: [' '] }, { ...valid, ids: Array.from({ length: 201 }, (_, i) => `id-${i}`) }, { ...valid, extra: true }]) {
    assert.equal((await call(body)).status, 400);
    assert.equal(archiveRequestSchema.safeParse(body).success, false);
  }
  assert.equal((await call('{', user, true)).status, 400);
  assert.equal(await prisma.changeOperation.count(), count);
  assert.ok((await prisma.person.findUniqueOrThrow({ where: { id: 'p1' } })).deletedAt);
});

for (const entity of ['people', 'events'] as const) {
  for (const action of ['restore', 'delete'] as const) {
    test(`${entity} ${action}: active/missing IDs reject the whole batch without journal changes`, async () => {
      await fixture();
      const ids = entity === 'people' ? ['p1', 'p2'] : ['e1', 'e2'];
      const count = await prisma.changeOperation.count();
      for (const invalid of ['missing', entity === 'people' ? 'active-person' : 'active-event']) {
        const response = await call(input(entity, action, [...ids, invalid]));
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, 'ARCHIVE_CONFLICT');
        assert.equal(await prisma.changeOperation.count(), count);
        const row = entity === 'people' ? await prisma.person.findUniqueOrThrow({ where: { id: ids[0] } }) : await prisma.event.findUniqueOrThrow({ where: { id: ids[0] } });
        assert.ok(row.deletedAt);
        assert.equal(await prisma.participation.count(), 2);
      }
    });
  }
  test(`${entity}: single and bulk restore retain dependents and journal the change`, async () => {
    await fixture();
    const ids = entity === 'people' ? ['p1', 'p2'] : ['e1', 'e2'];
    for (const id of ids) {
      const response = await call(input(entity, 'restore', [id]));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).count, 1);
    }
    assert.equal(await prisma.participation.count(), 2);
    assert.equal(await prisma.passportScan.count(), 1);
    assert.equal(await prisma.excursion.count(), 1);
    const captured = await capture();
    const model = entity === 'people' ? 'Person' : 'Event';
    for (const id of ids) assert.equal(captured.data.snapshots[model].find((row) => row.id === id)?.deletedAt, null);
    await fixtureResetArchive(entity, ids);
    const rearchived = await capture();
    assert.equal((await call(input(entity, 'restore', ids))).status, 200);
    const restored = await capture();
    const plan = buildMergePlan(rearchived.data, restored.data);
    assert.equal(plan.records.length, 2);
    for (const record of plan.records) {
      assert.equal(record.proposed?.deletedAt, null);
      assert.equal(record.deletion, false);
    }
  });

  test(`${entity}: permanent deletion cascades, exports history and propagates to a peer without resurrection`, async () => {
    await fixture();
    const baseline = await capture();
    const raw = await prisma.$transaction(async (tx) => ({ people: await tx.person.findMany(), events: await tx.event.findMany(), scans: await tx.passportScan.findMany(), parts: await tx.participation.findMany(), excursions: await tx.excursion.findMany(), operations: await tx.changeOperation.findMany() }));
    const ids = entity === 'people' ? ['p1', 'p2'] : ['e1', 'e2'];
    const response = await call(input(entity, 'delete', ids));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).count, 2);
    const deleted = await capture();
    const expected = entity === 'people' ? ['Person:p1', 'Person:p2', 'PassportScan:scan', 'Participation:part-person'] : ['Event:e1', 'Event:e2', 'Excursion:excursion', 'Participation:part-event'];
    const tombstones = deleted.data.operations.filter((op) => op.after === null).map((op) => `${op.entity}:${op.entityId}`).sort();
    assert.deepEqual(tombstones, expected.sort());
    assert.equal(await prisma.participation.count(), 1);
    assert.equal(await prisma.person.count({ where: { id: 'active-person' } }), 1);
    assert.equal(await prisma.event.count({ where: { id: 'active-event' } }), 1);
    const { readScanFile } = await import('../lib/uploads');
    assert.deepEqual(await readScanFile('p1/original.pdf'), pdf);
    const buffer = await buildBundle(deleted.data, deleted.files, { databaseId: deleted.databaseId, deviceId: 'archive-device' });
    const parsed = await parseBundle(buffer);
    assert.equal(parsed.files.size, 1);
    assert.ok(parsed.data.operations.some((op) => op.entity === 'PassportScan' && op.after?.filename === 'original.pdf'));
    // Recreate an offline peer at the baseline, using the same isolated test DB.
    await journal.withoutJournal(() => prisma.$transaction(async (tx) => {
      await tx.person.deleteMany(); await tx.event.deleteMany(); await tx.changeOperation.deleteMany();
      await tx.person.createMany({ data: raw.people }); await tx.event.createMany({ data: raw.events });
      await tx.passportScan.createMany({ data: raw.scans }); await tx.excursion.createMany({ data: raw.excursions });
      await tx.participation.createMany({ data: raw.parts }); await tx.changeOperation.createMany({ data: raw.operations });
    }));
    const job = await sync.previewSyncBundle(buffer, 'archive-test');
    assert.deepEqual(job.plan.records.map((record) => record.key).sort(), expected);
    await assert.rejects(sync.applySyncJob(job.id, 'archive-test', job.fingerprint, {}), /явного решения/);
    const decisions: Decisions = Object.fromEntries(job.plan.records.map((record) => [record.key, { action: 'accept' }]));
    assert.equal((await sync.applySyncJob(job.id, 'archive-test', job.fingerprint, decisions)).complete, true);
    const peer = await capture();
    assert.equal(buildMergePlan(peer.data, baseline.data).records.length, 0);
    assert.equal(buildMergePlan(peer.data, parsed.data).records.length, 0);
    const { clearOwnerJobs } = await import('../lib/sync/jobs'); clearOwnerJobs('archive-test');
  });
}

async function fixtureResetArchive(entity: ArchiveRequest['entity'], ids: string[]) {
  if (entity === 'people') await prisma.person.updateMany({ where: { id: { in: ids } }, data: { deletedAt: date } });
  else await prisma.event.updateMany({ where: { id: { in: ids } }, data: { deletedAt: date } });
}

test('a journal failure rolls back bulk changes and cascades together', async () => {
  await fixture();
  const count = await prisma.changeOperation.count();
  await prisma.$executeRawUnsafe('CREATE TRIGGER archive_test_fail BEFORE INSERT ON ChangeOperation BEGIN SELECT RAISE(ABORT, \'synthetic journal failure\'); END');
  try {
    for (const entity of ['people', 'events'] as const) for (const action of ['restore', 'delete'] as const) {
      await assert.rejects(service.applyArchiveAction(input(entity, action, entity === 'people' ? ['p1', 'p2'] : ['e1', 'e2'])));
      assert.equal(await prisma.person.count(), 4);
      assert.equal(await prisma.event.count(), 4);
      assert.ok((await prisma.person.findUniqueOrThrow({ where: { id: 'p1' } })).deletedAt);
      assert.ok((await prisma.event.findUniqueOrThrow({ where: { id: 'e1' } })).deletedAt);
      assert.equal(await prisma.passportScan.count(), 1);
      assert.equal(await prisma.excursion.count(), 1);
      assert.equal(await prisma.participation.count(), 2);
      assert.equal(await prisma.changeOperation.count(), count);
    }
  } finally { await prisma.$executeRawUnsafe('DROP TRIGGER archive_test_fail'); }
});
