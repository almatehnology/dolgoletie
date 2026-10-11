import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ColumnKey, Job, Table } from '../lib/batch-import/types';

let directory: string;
let prisma: typeof import('../lib/db')['prisma'];
let jobs: typeof import('../lib/batch-import/jobs')['jobs'];
let buildPlan: typeof import('../lib/batch-import/plan')['buildPlan'];
let readPeople: typeof import('../lib/batch-import/database')['readPeople'];
let applyJob: typeof import('../lib/batch-import/apply')['applyJob'];
const owner = 'synthetic-test-login';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tdb-batch-import-'));
  process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
  process.env.DATA_DIR = directory;
  // Only now load database modules. Never read .env or open the repository's database.
  ({ prisma } = await import('../lib/db'));
  ({ jobs } = await import('../lib/batch-import/jobs'));
  ({ buildPlan } = await import('../lib/batch-import/plan'));
  ({ readPeople } = await import('../lib/batch-import/database'));
  ({ applyJob } = await import('../lib/batch-import/apply'));
});
beforeEach(async () => {
  jobs.clearOwner(owner);
  await prisma.$transaction(async (tx) => { await tx.person.deleteMany(); await tx.importReceipt.deleteMany(); });
});
after(async () => { if (prisma) await prisma.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
function table(id: string, columns: ColumnKey[], data: string[][]): Table {
  return { id, fileName: `${id}.xlsx`, name: 'Лист', rows: [columns.map(String), ...data].map((cells, i) => ({ number: i + 1, cells: cells.map((text) => ({ text })) })), warnings: [], selection: { tableId: id, included: true, headerStart: 1, headerEnd: 1, columns } };
}
async function preview(tables: Table[]): Promise<Job> {
  const job = jobs.create(owner, tables); job.plan = buildPlan(job, await readPeople()); return job;
}
test('preview writes nothing; import creates one person, dates and FTS, no events', async () => {
  const job = await preview([table('a', ['fullName', 'phone', 'birthDate'], [['Иванов Иван Иванович', '+70000000000', '1980-02-29']]), table('b', ['fullName', 'passportNumber', 'passportIssuedAt'], [['Иванов Иван Иванович', '0011 000222', '2020-01-02']])]);
  assert.equal(await prisma.person.count(), 0); assert.equal(await prisma.importReceipt.count(), 0);
  const result = await applyJob(owner, job.id, job.revision);
  assert.equal(result.created, 1); assert.equal(await prisma.person.count(), 1);
  const person = await prisma.person.findUniqueOrThrow({ where: { id: result.people[0].id } });
  assert.equal(person.birthDate, '1980-02-29'); assert.equal(person.passportNumber, '0011 000222'); assert.equal(person.passportIssuedAt?.toISOString(), '2020-01-02T00:00:00.000Z');
  assert.equal(await prisma.event.count(), 0); assert.equal(await prisma.participation.count(), 0);
  const fts = await prisma.$queryRawUnsafe<{ personId: string }[]>('SELECT personId FROM person_fts WHERE person_fts MATCH ?', 'Иванов');
  assert.equal(fts.length, 1);
});
test('repeated apply returns durable result even after the memory job disappears', async () => {
  const job = await preview([table('a', ['fullName'], [['Иванов Иван Иванович']])]);
  const version = job.revision;
  const first = await applyJob(owner, job.id, version);
  jobs.delete(job.id, owner);
  assert.deepEqual(await applyJob(owner, job.id, version), first);
  assert.equal(await prisma.person.count(), 1); assert.equal(await prisma.importReceipt.count(), 1);
  await assert.rejects(applyJob('other-session', job.id, version), /сессии/);
  await assert.rejects(applyJob(owner, job.id, version + 1), /другой версией/);
});
test('simultaneous confirmation cannot create the same people twice', async () => {
  const job = await preview([table('a', ['fullName'], [['Иванов Иван Иванович']])]);
  const results = await Promise.allSettled([applyJob(owner, job.id, job.revision), applyJob(owner, job.id, job.revision)]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.equal(await prisma.person.count(), 1); assert.equal(await prisma.importReceipt.count(), 1);
  const retry = await applyJob(owner, job.id, job.revision); assert.equal(retry.created, 1);
});
test('concurrent edits roll back and invalidate previous decisions', async () => {
  const person = await prisma.person.create({ data: { lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович' } });
  const job = await preview([table('a', ['fullName', 'phone'], [['Иванов Иван Иванович', '111']])]);
  await prisma.person.update({ where: { id: person.id }, data: { phone: '222' } });
  await assert.rejects(applyJob(owner, job.id, job.revision), /изменились/);
  assert.equal((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).phone, '222');
  assert.equal(job.revision, 2); assert.equal(job.plan?.blocked, 1); assert.equal(await prisma.importReceipt.count(), 0);
});
test('a new candidate appearing after preview prevents duplicate creation', async () => {
  const job = await preview([table('a', ['fullName'], [['Иванов Иван Иванович']])]);
  await prisma.person.create({ data: { lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович' } });
  await assert.rejects(applyJob(owner, job.id, job.revision), /изменились/);
  assert.equal(await prisma.person.count(), 1); assert.equal(await prisma.importReceipt.count(), 0);
  assert.equal(job.plan?.groups[0].action, 'existing');
});
test('review regression: a new near-name candidate with a different surname prefix blocks creation', async () => {
  const job = await preview([table('a', ['lastName', 'firstName'], [['Иванов', 'Иван']])]);
  await prisma.person.create({ data: { lastName: 'Еванов', firstName: 'Иван' } });
  await assert.rejects(applyJob(owner, job.id, job.revision), /изменились/);
  assert.equal(await prisma.person.count(), 1); assert.equal(await prisma.importReceipt.count(), 0);
  assert.equal(job.plan!.groups[0].action, 'unresolved');
});
test('review regression: duplicate passport columns cannot write a receipt or person', async () => {
  const job = await preview([table('a', ['lastName', 'firstName', 'passportSeries', 'passportDigits', 'passportDigits'], [['Иванов', 'Иван', '0011', '000111', '000222']])]);
  await assert.rejects(applyJob(owner, job.id, job.revision), /конфликты/);
  assert.equal(await prisma.person.count(), 0); assert.equal(await prisma.importReceipt.count(), 0);
});
test('candidate introduced by corrected fields is rechecked in the transaction', async () => {
  const job = await preview([table('a', ['fullName', 'passportNumber'], [['Иванов Иван Иванович', '111']])]);
  job.decisions = [{ groupId: job.plan!.groups[0].id, action: 'new', fields: { passportNumber: '999' } }];
  job.plan = buildPlan(job, await readPeople());
  await prisma.person.create({ data: { lastName: 'Сидоров', firstName: 'Пётр', passportNumber: '999' } });
  await assert.rejects(applyJob(owner, job.id, job.revision), /изменились/);
  assert.equal(await prisma.person.count(), 1);
});
test('a failing second insert rolls back both people and receipt', async () => {
  const job = await preview([table('a', ['lastName', 'firstName'], [['Аа', 'Первый'], ['Яя', 'Второй']])]);
  await prisma.$executeRawUnsafe("CREATE TRIGGER batch_test_abort BEFORE INSERT ON Person WHEN NEW.firstName = 'Второй' BEGIN SELECT RAISE(ABORT, 'synthetic test failure'); END");
  try {
    await assert.rejects(applyJob(owner, job.id, job.revision));
    assert.equal(await prisma.person.count(), 0); assert.equal(await prisma.importReceipt.count(), 0);
  } finally { await prisma.$executeRawUnsafe('DROP TRIGGER batch_test_abort'); }
});
test('archive update keeps deletedAt unless explicit restoration is chosen', async () => {
  const person = await prisma.person.create({ data: { lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович', phone: '111', deletedAt: new Date('2025-01-01T00:00:00Z') } });
  const job = await preview([table('a', ['fullName', 'phone', 'birthDate'], [['Иванов Иван Иванович', '', '1980-01-01']])]);
  job.decisions = [{ groupId: job.plan!.groups[0].id, action: 'existing', personId: person.id }]; job.plan = buildPlan(job, await readPeople());
  const first = await applyJob(owner, job.id, job.revision); assert.equal(first.updated, 1); assert.equal(first.restored, 0);
  const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } }); assert.ok(after.deletedAt); assert.equal(after.phone, '111');
  const restore = await preview([table('b', ['fullName'], [['Иванов Иван Иванович']])]);
  restore.decisions = [{ groupId: restore.plan!.groups[0].id, action: 'existing', personId: person.id, restore: true }]; restore.plan = buildPlan(restore, await readPeople());
  assert.equal((await applyJob(owner, restore.id, restore.revision)).restored, 1);
  assert.equal((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).deletedAt, null);
});
test('unresolved, stale-version and cancelled jobs cannot partially apply', async () => {
  const job = await preview([table('a', ['lastName', 'firstName'], [['Иванов', 'Иван'], ['Петров', '']])]);
  await assert.rejects(applyJob(owner, job.id, job.revision), /конфликты/); assert.equal(await prisma.person.count(), 0);
  const problem = job.plan!.groups.find((g) => g.status === 'error')!;
  job.decisions = [{ groupId: problem.id, action: 'skip' }]; job.plan = buildPlan(job, await readPeople());
  await assert.rejects(applyJob(owner, job.id, 999), /План изменился/);
  const result = await applyJob(owner, job.id, job.revision); assert.equal(result.created, 1); assert.equal(result.skipped, 1);
  const cancelled = await preview([table('b', ['fullName'], [['Сидоров Пётр Петрович']])]); jobs.delete(cancelled.id, owner);
  await assert.rejects(applyJob(owner, cancelled.id, cancelled.revision), /отменено/);
  assert.equal(await prisma.person.count(), 1);
});
