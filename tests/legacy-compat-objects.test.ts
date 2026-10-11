import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('legacy object imports preserve birth dates and excursion identity without borrowing foreign IDs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tdb-legacy-objects-'));
  process.env.DATA_DIR = directory;
  process.env.DATABASE_URL = `file:${join(directory, 'data.db')}`;
  process.env.UPLOADS_DIR = join(directory, 'uploads');
  process.env.AUTH_FILE = join(directory, 'auth.json');
  const { prisma } = await import('../lib/db');
  const { importPerson, importEvent, personEnvelopeSchema, eventEnvelopeSchema, buildEventEnvelope } = await import('../lib/object-export');
  const date = new Date('2026-10-11T00:00:00Z');
  try {
    await t.test('an old person JSON without birthDate does not erase a populated date', async () => {
      const person = await prisma.person.create({ data: {
        lastName: 'Иванова', firstName: 'Анна', passportNumber: '0012 000034', birthDate: '1984-02-29',
      } });
      const imported = await importPerson(personEnvelopeSchema.parse({ type: 'dolgoletie/person', version: 1,
        data: { lastName: 'Иванова', firstName: 'Анна', passportNumber: '0012 000034', phone: '+7000000000' } }));
      assert.equal(imported.action, 'updated');
      assert.equal(imported.record.id, person.id);
      assert.equal(imported.record.birthDate, '1984-02-29');
    });

    const event = await prisma.event.create({ data: {
      title: 'Поездка', startDate: date, endDate: date, location: 'Москва',
      excursions: { create: [{ name: 'Музей', cost: '0' }, { name: 'Парк' }] },
    }, include: { excursions: true } });
    const museum = event.excursions.find((ex) => ex.name === 'Музей')!;
    const park = event.excursions.find((ex) => ex.name === 'Парк')!;
    const envelope = buildEventEnvelope(event);

    await t.test('exported excursion IDs survive validation and repeated import', async () => {
      assert.equal(eventEnvelopeSchema.parse(envelope).data.excursions![0].id, event.excursions[0].id);
      await importEvent(eventEnvelopeSchema.parse(envelope));
      await importEvent(eventEnvelopeSchema.parse(envelope));
      assert.deepEqual((await prisma.excursion.findMany({ where: { eventId: event.id } })).map((ex) => ex.id).sort(), [museum.id, park.id].sort());
    });

    await t.test('idless old JSON reuses unambiguous names; IDs permit renames, new rows and deletions', async () => {
      const old = { ...envelope, data: { ...envelope.data,
        excursions: envelope.data.excursions.map(({ id: _id, ...ex }) => ex),
      } };
      await importEvent(eventEnvelopeSchema.parse(old));
      assert.ok(await prisma.excursion.findUnique({ where: { id: museum.id } }));
      const changed = structuredClone(envelope);
      changed.data.excursions = [{ id: museum.id, name: 'Новый музей', cost: '12' }, { id: 'portable-excursion', name: 'Театр', cost: null }];
      await importEvent(eventEnvelopeSchema.parse(changed));
      assert.equal((await prisma.excursion.findUniqueOrThrow({ where: { id: museum.id } })).name, 'Новый музей');
      assert.equal((await prisma.excursion.findUniqueOrThrow({ where: { id: 'portable-excursion' } })).eventId, event.id);
      assert.equal(await prisma.excursion.findUnique({ where: { id: park.id } }), null);
    });

    await t.test('foreign and duplicate IDs roll back the entire object import', async () => {
      const other = await prisma.event.create({ data: {
        title: 'Другое', startDate: date, endDate: date, location: 'Пермь', excursions: { create: { name: 'Чужая' } },
      }, include: { excursions: true } });
      const before = await prisma.excursion.findMany({ where: { eventId: event.id }, orderBy: { id: 'asc' } });
      for (const excursions of [
        [{ id: other.excursions[0].id, name: 'Чужая', cost: null }],
        [{ id: museum.id, name: 'Первый', cost: null }, { id: museum.id, name: 'Повтор', cost: null }],
      ]) {
        await assert.rejects(importEvent(eventEnvelopeSchema.parse({ ...envelope, data: { ...envelope.data, location: 'Изменено', excursions } })), /Некорректные идентификаторы/);
        assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).location, 'Москва');
        assert.deepEqual(await prisma.excursion.findMany({ where: { eventId: event.id }, orderBy: { id: 'asc' } }), before);
      }
      await assert.rejects(importEvent(eventEnvelopeSchema.parse({ ...envelope, data: { ...envelope.data, title: 'Новая поездка', excursions: [{ id: other.excursions[0].id, name: 'Чужая' }] } })), /принадлежит другому/);
      assert.equal(await prisma.event.count({ where: { title: 'Новая поездка' } }), 0);
    });

    await t.test('omitted excursions leave the list intact and an empty list removes it', async () => {
      const { excursions: _excursions, ...data } = envelope.data;
      await importEvent(eventEnvelopeSchema.parse({ ...envelope, data }));
      assert.equal(await prisma.excursion.count({ where: { eventId: event.id } }), 2);
      await importEvent(eventEnvelopeSchema.parse({ ...envelope, data: { ...data, excursions: [] } }));
      assert.equal(await prisma.excursion.count({ where: { eventId: event.id } }), 0);
    });
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
