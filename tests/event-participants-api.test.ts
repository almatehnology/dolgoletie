import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextRequest } from 'next/server';
import type { SessionData } from '../lib/auth/types';
import type { RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external';
import type { WorkStore } from 'next/dist/server/app-render/work-async-storage.external';

let directory: string;
let prisma: typeof import('../lib/db')['prisma'];
let journal: typeof import('../lib/sync/journal');
let route: typeof import('../app/api/events/[id]/participants/route');
let realGuards: typeof import('../lib/auth/guards');
let registry: typeof import('../lib/auth/session-registry');
let mutex: typeof import('../lib/auth/mutex');
let workStorage: typeof import('next/dist/server/app-render/work-async-storage.external');
let requestStorage: typeof import('next/dist/server/app-render/work-unit-async-storage.external');
let nextCookies: typeof import('next/dist/server/web/spec-extension/cookies');
let iron: typeof import('iron-session');
let session: SessionData;
const secret = 'synthetic-participants-session-secret-at-least-32-characters';
let guard = mock.fn(async (): Promise<unknown> => ({ id: 'synthetic-user' }));
const globals = globalThis as typeof globalThis & { eventParticipantsGuard?: () => Promise<unknown> };
const previousGuard = globals.eventParticipantsGuard;
const previousEnv = Object.fromEntries(
  ['DATABASE_URL', 'DATA_DIR', 'AUTH_FILE', 'UPLOADS_DIR', 'SESSION_SECRET'].map((key) => [key, process.env[key]]),
);

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tdb-participants-'));
  // Redirect storage before importing application modules; never touch the owner's database.
  process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
  process.env.DATA_DIR = directory;
  process.env.AUTH_FILE = join(directory, 'auth.json');
  process.env.UPLOADS_DIR = join(directory, 'uploads');
  process.env.SESSION_SECRET = secret;
  Object.assign(globalThis, { AsyncLocalStorage });
  // Load the real guard first; the route's proxy below counts calls and permits explicit denials.
  realGuards = await import('../lib/auth/guards');
  registry = await import('../lib/auth/session-registry');
  mutex = await import('../lib/auth/mutex');
  workStorage = await import('next/dist/server/app-render/work-async-storage.external');
  requestStorage = await import('next/dist/server/app-render/work-unit-async-storage.external');
  nextCookies = await import('next/dist/server/web/spec-extension/cookies');
  iron = await import('iron-session');
  const store = await import('../lib/auth/store');
  const passwordHash = await store.hashPassword('synthetic-participants-password');
  await store.updateAuth(() => ({
    version: 1,
    admin: { id: 'admin', username: 'admin', passwordHash },
    primary: { id: 'synthetic-user', username: 'operator', passwordHash, version: 1 },
  }));
  globals.eventParticipantsGuard = () => guard();
  const guardFile = join(directory, 'guard.cjs');
  await writeFile(guardFile, 'exports.requireUser = () => globalThis.eventParticipantsGuard();\n');
  const guardUrl = pathToFileURL(guardFile).href;
  const realGuardPath = resolve('lib/auth/guards');
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if ([ '@/lib/auth/guards', realGuardPath, `${realGuardPath}.ts` ].includes(specifier)) {
        return { url: guardUrl, shortCircuit: true };
      }
      const resolved = nextResolve(specifier, context);
      return resolved.url === pathToFileURL(`${realGuardPath}.ts`).href
        ? { url: guardUrl, shortCircuit: true } : resolved;
    },
  });
  try {
    ({ prisma } = await import('../lib/db'));
    journal = await import('../lib/sync/journal');
    route = await import('../app/api/events/[id]/participants/route');
  } finally {
    hooks.deregister();
  }
});

beforeEach(async () => {
  guard = mock.fn(async (): Promise<unknown> => realGuards.requireUser());
  registry.sessionRegistry.configure(15);
  session = { authenticated: true, userId: 'synthetic-user', role: 'user', authVersion: 1 };
  session.sessionId = registry.sessionRegistry.register(session);
  await journal.withoutJournal(() => prisma.$transaction(async (tx) => {
    await tx.person.deleteMany();
    await tx.event.deleteMany();
    await tx.changeOperation.deleteMany();
    await tx.databaseMetadata.deleteMany();
    await tx.event.create({ data: {
      id: 'event', title: 'Поездка', location: 'Место',
      startDate: new Date('2026-10-20'), endDate: new Date('2026-10-21'),
    } });
    for (const id of ['first', 'second', 'existing', 'archived']) {
      await tx.person.create({ data: {
        id, lastName: id, firstName: 'Человек', deletedAt: id === 'archived' ? new Date('2026-10-01') : null,
      } });
    }
    await tx.participation.create({ data: { eventId: 'event', personId: 'existing', notes: 'Сохранить' } });
  }));
});

after(async () => {
  try {
    registry?.sessionRegistry.revoke();
    if (prisma) await prisma.$disconnect();
  } finally {
    if (previousGuard === undefined) delete globals.eventParticipantsGuard;
    else globals.eventParticipantsGuard = previousGuard;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

function request(body: unknown): NextRequest {
  return new Request('http://localhost/api/events/event/participants', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as NextRequest;
}
function post(body: unknown, id = 'event') {
  return context(() => route.POST(request(body), { params: Promise.resolve({ id }) }));
}
async function context<T>(task: () => Promise<T>): Promise<T> {
  const jar = new nextCookies.ResponseCookies(new Headers());
  jar.set('tdb_session', await iron.sealData(session, { password: secret }));
  const work = { isStaticGeneration: false, route: '/api/events/event/participants', page: '/api/events/event/participants/route' } as WorkStore;
  const req = { type: 'request', phase: 'action', cookies: jar, userspaceMutableCookies: jar, mutableCookies: jar } as unknown as RequestStore;
  return workStorage.workAsyncStorage.run(work, () => requestStorage.workUnitAsyncStorage.run(req, task));
}
async function snapshot() {
  return JSON.parse(JSON.stringify({
    participations: await prisma.participation.findMany({ orderBy: { id: 'asc' } }),
    operations: await prisma.changeOperation.findMany({ orderBy: { id: 'asc' } }),
    metadata: await prisma.databaseMetadata.findMany({ orderBy: { id: 'asc' } }),
  }));
}

test('bulk creates every selected person with shared payment fields and journals each creation', async () => {
  const response = await post({ personIds: ['first', 'second'], paymentStatus: 'PREPAID', prepaidAmount: '12.50', totalDue: 100, notes: ' Группа ' });
  assert.equal(response.status, 201);
  assert.equal(guard.mock.callCount(), 2, 'Recheck the real registered session after acquiring the transition lock');
  const body = await response.json();
  assert.equal(body.count, 2);
  assert.deepEqual(body.items.map((item: any) => item.personId), ['first', 'second']);
  assert.equal(await prisma.participation.count(), 3);
  for (const item of body.items) {
    assert.equal(item.person.id, item.personId);
    assert.equal(item.event.id, 'event');
    assert.equal(item.paymentStatus, 'PREPAID');
    assert.equal(item.prepaidAmount, '12.5');
    assert.equal(item.totalDue, '100');
    assert.equal(item.notes, 'Группа');
    const stored = await prisma.participation.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(stored.personId, item.personId);
    assert.equal(stored.prepaidAmount?.toString(), '12.5');
    const change = await prisma.changeOperation.findFirst({ where: { entityId: item.id } });
    assert.ok(change, 'Each new participation must be in the sync journal');
    assert.equal(JSON.parse(change.after!).personId, item.personId);
  }
  assert.equal((await prisma.participation.findFirstOrThrow({ where: { personId: 'existing' } })).notes, 'Сохранить');
});

test('a one-person bulk request uses bulk shape and defaults', async () => {
  const response = await post({ personIds: ['first'] });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.items[0].paymentStatus, 'UNPAID');
  assert.equal(body.items[0].prepaidAmount, null);
  assert.equal(body.items[0].totalDue, null);
});

test('the existing personId API retains its response shape, defaults and payment support', async () => {
  for (const input of [{ personId: 'first' }, { personId: 'second', paymentStatus: 'PAID', prepaidAmount: 0, totalDue: '42', notes: 'Заметка' }]) {
    const response = await post(input);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.personId, input.personId);
    assert.equal(body.person.id, input.personId);
    assert.equal(body.event.id, 'event');
    assert.equal(body.paymentStatus, input.paymentStatus ?? 'UNPAID');
    assert.equal(body.prepaidAmount, input.prepaidAmount === undefined ? null : '0');
    assert.equal(body.totalDue, input.totalDue ?? null);
    assert.equal(body.items, undefined);
    assert.equal(body.count, undefined);
  }
});

for (const [label, body] of [
  ['empty selection', { personIds: [] }],
  ['duplicate selection', { personIds: ['first', 'first'] }],
  ['duplicates after trimming', { personIds: ['first', ' first '] }],
  ['blank ID', { personIds: ['first', ' \t '] }],
  ['non-string ID', { personIds: ['first', 2] }],
  ['null ID', { personIds: ['first', null] }],
  ['not an array', { personIds: 'first' }],
  ['missing selection', {}],
  ['ambiguous formats', { personId: 'first', personIds: ['second'] }],
  ['invalid amount', { personIds: ['first', 'second'], prepaidAmount: 'oops' }],
  ['invalid total', { personIds: ['first', 'second'], totalDue: {} }],
  ['invalid payment status', { personIds: ['first', 'second'], paymentStatus: 'INVALID' }],
  ['too many people', { personIds: Array.from({ length: 201 }, (_, i) => `person-${i}`) }],
  ['oversized bulk ID', { personIds: ['first', 'x'.repeat(129)] }],
  ['oversized single ID', { personId: 'x'.repeat(129) }],
] as const) {
  test(`${label} is rejected with VALIDATION before any writes`, async () => {
    const before = await snapshot();
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VALIDATION');
    assert.deepEqual(await snapshot(), before);
  });
}

for (const id of ['missing', 'archived']) {
  test(`a ${id} person anywhere in the batch rejects everyone before inserting`, async () => {
    const before = await snapshot();
    await prisma.$executeRawUnsafe("CREATE TRIGGER reject_participation_insert BEFORE INSERT ON Participation BEGIN SELECT RAISE(ABORT, 'validation must precede writes'); END");
    try {
      const response = await post({ personIds: ['first', id, 'second'] });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, 'VALIDATION');
      assert.ok(body.error.fields['personIds.1']);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_participation_insert');
    }
  });
}

test('an existing participant rejects the entire batch and preserves the existing record', async () => {
  const before = await snapshot();
  const response = await post({ personIds: ['first', 'existing', 'second'], paymentStatus: 'PAID' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'CONFLICT');
  assert.deepEqual(await snapshot(), before);
});

test('repeating an accepted batch returns conflict without duplicates or extra journal entries', async () => {
  const body = { personIds: ['first', 'second'] };
  assert.equal((await post(body)).status, 201);
  const accepted = await snapshot();
  assert.equal((await post(body)).status, 409);
  assert.deepEqual(await snapshot(), accepted);
});

test('the single API retains conflict handling for an existing participant', async () => {
  const before = await snapshot();
  assert.equal((await post({ personId: 'existing' })).status, 409);
  assert.deepEqual(await snapshot(), before);
});

test('a missing event returns 404 without creating participations or journal metadata', async () => {
  const before = await snapshot();
  const response = await post({ personIds: ['first', 'second'] }, 'missing');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
  assert.deepEqual(await snapshot(), before);
});

for (const input of [{ personIds: ['first', 'second'] }, { personId: 'first' }]) {
  test(`an archived event rejects ${'personId' in input ? 'single' : 'bulk'} addition without writes`, async () => {
    await journal.withoutJournal(() => prisma.event.update({ where: { id: 'event' }, data: { deletedAt: new Date() } }));
    const before = await snapshot();
    const response = await post(input);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'CONFLICT');
    assert.deepEqual(await snapshot(), before);
  });
}

test('exactly 200 people and a 128-character ID are accepted in one operation', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => i === 0 ? 'x'.repeat(128) : `person-${i}`);
  await journal.withoutJournal(() => prisma.$transaction(async (tx) => {
    await tx.person.createMany({ data: ids.map((id) => ({ id, firstName: 'Имя', lastName: id })) });
  }));
  const response = await post({ personIds: ids });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.count, 200);
  assert.deepEqual(body.items.map((item: any) => item.personId), ids);
  assert.equal(await prisma.participation.count(), 201);
});

test('a session revoked while waiting on a vault transition cannot insert single or bulk participants', async () => {
  for (const input of [{ personIds: ['first', 'second'] }, { personId: 'first' }]) {
    session.sessionId = registry.sessionRegistry.register(session);
    const before = await snapshot();
    let release!: () => void;
    let acquired!: () => void;
    let checked!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const initialCheck = new Promise<void>((resolve) => { checked = resolve; });
    guard = mock.fn(async () => { const user = await realGuards.requireUser(); checked(); return user; });
    const transition = mutex.withAuthOperation(async () => { acquired(); await held; });
    await ready;
    const pending = post(input);
    try {
      await initialCheck;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(guard.mock.callCount(), 1);
      assert.deepEqual(await snapshot(), before, 'No writes while another transition holds the lock');
      registry.sessionRegistry.revoke();
    } finally {
      release();
      await transition;
    }
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal(guard.mock.callCount(), 2);
    assert.deepEqual(await snapshot(), before);
  }
});

test('failure on the second insert rolls back the first insert and all journal changes', async () => {
  const before = await snapshot();
  // Only abort after the first insert has actually occurred in the transaction.
  await prisma.$executeRawUnsafe("CREATE TRIGGER fail_second_participation BEFORE INSERT ON Participation WHEN NEW.personId = 'second' AND EXISTS (SELECT 1 FROM Participation WHERE personId = 'first') BEGIN SELECT RAISE(ABORT, 'synthetic second insert failure'); END");
  const log = mock.method(console, 'error', () => {});
  try {
    const response = await post({ personIds: ['first', 'second'] });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, 'INTERNAL');
    assert.deepEqual(await snapshot(), before);
  } finally {
    log.mock.restore();
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_second_participation');
  }
});

test('malformed JSON is a BAD_REQUEST without writes', async () => {
  const before = await snapshot();
  const req = new Request('http://localhost/api/events/event/participants', { method: 'POST', body: '{' }) as NextRequest;
  const response = await context(() => route.POST(req, { params: Promise.resolve({ id: 'event' }) }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'BAD_REQUEST');
  assert.deepEqual(await snapshot(), before);
});

for (const status of [401, 403, 423]) {
  test(`the guard's ${status} Response is returned before parsing the bulk request`, async () => {
    const before = await snapshot();
    const denied = new Response(null, { status });
    guard = mock.fn(async () => { throw denied; });
    const req = request({ personIds: ['first', 'second'] });
    const json = mock.method(req, 'json', async () => { throw new Error('Must not parse'); });
    assert.equal(await route.POST(req, { params: Promise.resolve({ id: 'event' }) }), denied);
    assert.equal(json.mock.callCount(), 0);
    assert.deepEqual(await snapshot(), before);
  });
}
