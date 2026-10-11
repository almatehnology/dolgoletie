import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks, type ModuleHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NextRequest } from 'next/server';

let directory: string;
let hooks: ModuleHooks | undefined;
let prisma: typeof import('../lib/db')['prisma'];
let journal: typeof import('../lib/sync/journal');
let route: typeof import('../app/api/events/[id]/route');
let guard = mock.fn(async (): Promise<unknown> => ({ id: 'synthetic-user' }));
const globals = globalThis as typeof globalThis & { legacyCompatEventsGuard?: () => Promise<unknown> };
const previousGuard = globals.legacyCompatEventsGuard;
const previousEnv = Object.fromEntries(
  ['DATABASE_URL', 'DATA_DIR', 'AUTH_FILE', 'UPLOADS_DIR'].map((key) => [key, process.env[key]]),
);

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tdb-legacy-events-'));
  // Set paths before loading any application module; never use the workspace database.
  process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
  process.env.DATA_DIR = directory;
  process.env.AUTH_FILE = join(directory, 'auth.json');
  process.env.UPLOADS_DIR = join(directory, 'uploads');
  globals.legacyCompatEventsGuard = () => guard();
  const guardFile = join(directory, 'guard.cjs');
  await writeFile(guardFile, 'exports.requireUser = () => globalThis.legacyCompatEventsGuard();\n');
  const guardUrl = pathToFileURL(guardFile).href;
  const realGuardPath = resolve('lib/auth/guards');
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@/lib/auth/guards' || specifier === realGuardPath || specifier === `${realGuardPath}.ts`) {
        return { url: guardUrl, shortCircuit: true };
      }
      const resolved = nextResolve(specifier, context);
      return resolved.url === pathToFileURL(`${realGuardPath}.ts`).href
        ? { url: guardUrl, shortCircuit: true }
        : resolved;
    },
  });
  try {
    ({ prisma } = await import('../lib/db'));
    journal = await import('../lib/sync/journal');
    route = await import('../app/api/events/[id]/route');
  } finally {
    hooks.deregister();
    hooks = undefined;
  }
});

beforeEach(async () => {
  guard = mock.fn(async (): Promise<unknown> => ({ id: 'synthetic-user' }));
  await journal.withoutJournal(() => prisma.$transaction(async (tx) => {
    await tx.event.deleteMany();
    await tx.changeOperation.deleteMany();
    await tx.databaseMetadata.deleteMany();
    await tx.event.create({ data: {
      id: 'event-main', title: 'Исходное мероприятие', location: 'Место',
      startDate: new Date('2026-10-11T00:00:00Z'), endDate: new Date('2026-10-12T00:00:00Z'),
      excursions: { create: [
        { id: 'excursion-keep', name: 'Старая прогулка', cost: '300' },
        { id: 'excursion-remove', name: 'Старый музей', cost: '500' },
      ] },
    } });
    await tx.event.create({ data: {
      id: 'event-other', title: 'Другое мероприятие', location: 'Другое место',
      startDate: new Date('2026-10-11T00:00:00Z'), endDate: new Date('2026-10-12T00:00:00Z'),
      excursions: { create: { id: 'excursion-foreign', name: 'Чужая экскурсия', cost: '700' } },
    } });
  }));
});

after(async () => {
  hooks?.deregister();
  try {
    if (prisma) await prisma.$disconnect();
  } finally {
    if (previousGuard === undefined) delete globals.legacyCompatEventsGuard;
    else globals.legacyCompatEventsGuard = previousGuard;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

function request(body: unknown, id = 'event-main'): NextRequest {
  return new Request(`http://localhost/api/events/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as NextRequest;
}

function patch(body: unknown, id = 'event-main') {
  return route.PATCH(request(body, id), { params: Promise.resolve({ id }) });
}

async function snapshot() {
  return JSON.parse(JSON.stringify({
    events: await prisma.event.findMany({ orderBy: { id: 'asc' } }),
    excursions: await prisma.excursion.findMany({ orderBy: { id: 'asc' } }),
    operations: await prisma.changeOperation.findMany({ orderBy: { id: 'asc' } }),
    metadata: await prisma.databaseMetadata.findMany({ orderBy: { id: 'asc' } }),
  }));
}

test('PATCH updates an existing excursion in place, creates new IDs and removes only omitted excursions', async () => {
  const other = await prisma.event.findUniqueOrThrow({ where: { id: 'event-other' }, include: { excursions: true } });
  // A delete/recreate with the same ID would also violate stable identity.
  await prisma.$executeRawUnsafe("CREATE TRIGGER preserve_excursion BEFORE DELETE ON Excursion WHEN OLD.id = 'excursion-keep' BEGIN SELECT RAISE(ABORT, 'retained excursion must not be deleted'); END");
  try {
    const response = await patch({ title: 'Обновлённое мероприятие', excursions: [
      { id: 'excursion-keep', name: 'Новая прогулка', cost: 125.5 },
      { name: 'Новый музей', cost: ' 42.75 ' },
    ] });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.title, 'Обновлённое мероприятие');
    assert.equal(body.excursions.length, 2);
    assert.deepEqual(body.excursions.find((item: { id: string }) => item.id === 'excursion-keep'), {
      id: 'excursion-keep', eventId: 'event-main', name: 'Новая прогулка', cost: '125.5',
    });
    const added = body.excursions.find((item: { name: string }) => item.name === 'Новый музей');
    assert.ok(added.id);
    assert.ok(!['excursion-keep', 'excursion-remove', 'excursion-foreign'].includes(added.id));
    assert.equal(added.eventId, 'event-main');
    assert.equal(added.cost, '42.75');
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: 'event-main' }, include: { excursions: true } });
    assert.deepEqual(JSON.parse(JSON.stringify(stored)), body);
    assert.equal(await prisma.excursion.findUnique({ where: { id: 'excursion-remove' } }), null);
    assert.deepEqual(await prisma.event.findUniqueOrThrow({ where: { id: 'event-other' }, include: { excursions: true } }), other);
    const operations = await prisma.changeOperation.findMany({ where: { entity: 'Excursion', entityId: 'excursion-keep' } });
    const update = operations.find((operation) => operation.before !== null);
    assert.ok(update?.after);
    assert.equal(JSON.parse(update.before!).id, 'excursion-keep');
    assert.equal(JSON.parse(update.after).name, 'Новая прогулка');
    assert.equal(guard.mock.callCount(), 1);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER preserve_excursion');
  }
});

test('PATCH can reorder and repeatedly edit existing IDs while preserving both records', async () => {
  const body = { excursions: [
    { id: 'excursion-remove', name: 'Обновлённый музей', cost: 0 },
    { id: 'excursion-keep', name: 'Обновлённая прогулка', cost: '900' },
  ] };
  for (let i = 0; i < 2; i++) {
    assert.equal((await patch(body)).status, 200);
    const excursions = await prisma.excursion.findMany({ where: { eventId: 'event-main' }, orderBy: { id: 'asc' } });
    assert.deepEqual(excursions.map((item) => [item.id, item.name, item.cost?.toString()]), [
      ['excursion-keep', 'Обновлённая прогулка', '900'],
      ['excursion-remove', 'Обновлённый музей', '0'],
    ]);
  }
});

for (const body of [{ title: 'Только название' }, {}]) {
  test(`omitted excursions leave all IDs and values intact: ${JSON.stringify(body)}`, async () => {
    const before = await prisma.excursion.findMany({ orderBy: { id: 'asc' } });
    const response = await patch(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await prisma.excursion.findMany({ orderBy: { id: 'asc' } }), before);
    assert.equal((await response.json()).excursions.length, 2);
  });
}

test('an explicit empty list clears only the requested event', async () => {
  const other = await prisma.excursion.findUniqueOrThrow({ where: { id: 'excursion-foreign' } });
  const response = await patch({ excursions: [] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).excursions, []);
  assert.equal(await prisma.excursion.count({ where: { eventId: 'event-main' } }), 0);
  assert.deepEqual(await prisma.excursion.findUniqueOrThrow({ where: { id: 'excursion-foreign' } }), other);
});

test('legacy lists without IDs create distinct generated IDs, including duplicate names', async () => {
  const response = await patch({ excursions: [
    { name: 'Одинаковое название', cost: '10' }, { name: 'Одинаковое название' },
  ] });
  assert.equal(response.status, 200);
  const excursions = await prisma.excursion.findMany({ where: { eventId: 'event-main' } });
  assert.equal(excursions.length, 2);
  assert.equal(new Set(excursions.map((item) => item.id)).size, 2);
  assert.ok(excursions.every((item) => item.id && !['excursion-keep', 'excursion-remove'].includes(item.id)));
  assert.deepEqual(excursions.map((item) => item.cost?.toString() ?? null).sort(), ['10', null].sort());
});

for (const cost of [undefined, '']) {
  test(`an existing ID clears its optional cost when ${cost === undefined ? 'omitted' : 'empty'}`, async () => {
    assert.equal((await patch({ excursions: [{ id: 'excursion-keep', name: 'Без стоимости', cost }] })).status, 200);
    const excursion = await prisma.excursion.findUniqueOrThrow({ where: { id: 'excursion-keep' } });
    assert.equal(excursion.cost, null);
    assert.equal(excursion.name, 'Без стоимости');
  });
}

for (const [label, invalidId, message] of [
  ['unknown', 'does-not-exist', /не принадлежит|не найден/i],
  ['foreign', 'excursion-foreign', /не принадлежит/i],
  ['empty', '', /пуст/i],
  ['whitespace', ' \t ', /пуст/i],
  ['duplicate', 'excursion-keep', /повтор|дубли/i],
] as const) {
  test(`${label} excursion IDs return field-specific VALIDATION 400 before any changes`, async () => {
    const before = await snapshot();
    // Fail even a subsequently rolled-back update: validation must precede writes.
    await prisma.$executeRawUnsafe("CREATE TRIGGER reject_event_update BEFORE UPDATE ON Event BEGIN SELECT RAISE(ABORT, 'validation must precede event updates'); END");
    try {
      const response = await patch({ title: 'Не должно сохраниться', excursions: [
        { id: 'excursion-keep', name: 'Не должно обновиться', cost: '1' },
        { name: 'Не должно создаться' },
        { id: invalidId, name: 'Неверная экскурсия' },
      ] });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, 'VALIDATION');
      assert.match(body.error.message, message);
      assert.ok(body.error.fields['excursions.2.id'].length > 0);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_event_update');
    }
  });
}

for (const invalidId of [null, 123]) {
  test(`the existing validator rejects non-string ID ${invalidId} without writes`, async () => {
    const before = await snapshot();
    const response = await patch({ title: 'Не сохранять', excursions: [{ id: invalidId, name: 'Экскурсия' }] });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'VALIDATION');
    assert.ok(body.error.fields['excursions.0.id']);
    assert.deepEqual(await snapshot(), before);
  });
}

test('a missing event retains NOT_FOUND 404 and cannot create excursions', async () => {
  const before = await snapshot();
  for (const excursions of [undefined, [], [{ name: 'Не создавать' }]]) {
    const response = await patch({ title: 'Не создавать', excursions }, 'missing-event');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
    assert.deepEqual(await snapshot(), before);
  }
});

test('a database failure during insertion rolls back event updates, deletes, excursion edits and journal', async () => {
  const before = await snapshot();
  await prisma.$executeRawUnsafe("CREATE TRIGGER fail_excursion_insert BEFORE INSERT ON Excursion WHEN NEW.name = 'fail-new' BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
  const log = mock.method(console, 'error', () => {});
  try {
    const response = await patch({ title: 'Не сохранять', excursions: [
      { id: 'excursion-keep', name: 'Не обновлять', cost: '1' }, { name: 'fail-new' },
    ] });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, 'INTERNAL');
    assert.deepEqual(await snapshot(), before);
  } finally {
    log.mock.restore();
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_excursion_insert');
  }
});

for (const status of [401, 403, 423]) {
  test(`PATCH returns the guard's ${status} Response before parsing or writing`, async () => {
    const before = await snapshot();
    const denied = new Response(JSON.stringify({ error: { code: 'DENIED' } }), { status });
    guard = mock.fn(async () => { throw denied; });
    const req = request({ excursions: [] });
    const json = mock.method(req, 'json', async () => { throw new Error('must not parse an unauthorized request'); });
    assert.equal(await route.PATCH(req, { params: Promise.resolve({ id: 'event-main' }) }), denied);
    assert.equal(guard.mock.callCount(), 1);
    assert.equal(json.mock.callCount(), 0);
    assert.deepEqual(await snapshot(), before);
  });
}
