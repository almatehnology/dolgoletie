import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('temporary database: explicit IDs across SQLite batches, all event participants, birthDate and no attachments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'report-export-db-'));
  // These must be set BEFORE importing DB, storage, auth, or the repository.
  const previousUrl = process.env.DATABASE_URL;
  const previousDirectory = process.env.DATA_DIR;
  process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
  process.env.DATA_DIR = directory;
  const { prisma } = await import('../lib/db');
  const { closeDatabase } = await import('../lib/storage/database');
  const { withoutJournal } = await import('../lib/sync/journal');
  const { reportRepository } = await import('../lib/report-export/repository');
  const { parseReportRequest } = await import('../lib/report-export/model');
  const { loadTableReport } = await import('../lib/report-export/service');
  try {
    const ids = Array.from({ length: 451 }, (_, i) => `report-person-${i}`);
    await withoutJournal(async () => {
      await prisma.person.createMany({ data: ids.map((id, index) => ({
        id, lastName: `Фамилия ${index}`, firstName: 'Имя', birthDate: '1984-02-29',
        phone: '+7 000 000 00 00', passportNumber: '0012 000034',
      })) });
      await prisma.person.create({ data: { id: 'archived', lastName: 'Архивный', firstName: 'Участник', deletedAt: new Date() } });
      await prisma.event.create({ data: {
        id: 'report-event', title: 'Временное мероприятие', startDate: new Date('2026-10-11T00:00:00Z'),
        endDate: new Date('2026-10-11T00:00:00Z'), location: 'Место',
      } });
      await prisma.participation.createMany({ data: [...ids.slice(0, 125), 'archived'].map((personId) => ({
        personId, eventId: 'report-event', paymentStatus: 'PAID' as const, totalDue: '1000',
      })) });
    });
    const input = parseReportRequest({ context: 'people', personIds: [...ids].reverse(),
      fields: ['birthDate', 'phone', 'passportNumber', 'lastName'], format: 'pdf', orientation: 'portrait' });
    const report = await loadTableReport(input, reportRepository);
    assert.equal(report.rows.length, 451);
    assert.deepEqual(report.rows[0], ['29.02.1984', '+7 000 000 00 00', '0012 000034', 'Фамилия 450']);
    const exportedPeople = await reportRepository.findPeople(ids.slice(0, 1));
    assert.equal('scans' in exportedPeople[0], false);
    assert.equal('participations' in exportedPeople[0], false);
    const event = await reportRepository.findEvent('report-event');
    assert.equal(event?.people.length, 126);
    assert.ok(event?.people.some((person) => person.id === 'archived'));
    assert.equal(event?.people.some((person) => 'totalDue' in person || 'paymentStatus' in person), false);
    const eventInput = parseReportRequest({ context: 'event-participants', eventId: 'report-event',
      fields: ['lastName'], format: 'xlsx', orientation: 'landscape' });
    assert.equal((await loadTableReport(eventInput, reportRepository)).rows.length, 126);
  } finally {
    await closeDatabase();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousDirectory === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
