import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import type { AuthMetadata, SessionData } from '../lib/auth/types';
import type { JobView } from '../lib/batch-import/types';
import type { RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external';
import type { WorkStore } from 'next/dist/server/app-render/work-async-storage.external';

let directory: string;
let prisma: typeof import('../lib/db')['prisma'];
let store: typeof import('../lib/auth/store');
let jobs: typeof import('../lib/batch-import/jobs')['jobs'];
let iron: typeof import('iron-session');
let sessionRegistry: typeof import('../lib/auth/session-registry').sessionRegistry;
let activeFixtureId: string | undefined;
let workStorage: typeof import('next/dist/server/app-render/work-async-storage.external');
let requestStorage: typeof import('next/dist/server/app-render/work-unit-async-storage.external');
let nextCookies: typeof import('next/dist/server/web/spec-extension/cookies');
let create: typeof import('../app/api/batch-import/jobs/route');
let item: typeof import('../app/api/batch-import/jobs/[id]/route');
let plan: typeof import('../app/api/batch-import/jobs/[id]/plan/route');
let apply: typeof import('../app/api/batch-import/jobs/[id]/apply/route');
let receipt: typeof import('../app/api/batch-import/jobs/[id]/receipt/route');
let candidates: typeof import('../app/api/batch-import/jobs/[id]/candidates/route');
let http: typeof import('../lib/batch-import/http');
let fixture: AuthMetadata;
let userCookie: string;
let adminCookie: string;
const secret = 'synthetic-batch-api-session-secret-more-than-32-characters';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tdb-batch-api-'));
  process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
  process.env.DATA_DIR = directory; process.env.AUTH_FILE = join(directory, 'auth.json'); process.env.UPLOADS_DIR = join(directory, 'uploads'); process.env.SESSION_SECRET = secret;
  Object.assign(globalThis, { AsyncLocalStorage });
  ({ prisma } = await import('../lib/db')); ({ jobs } = await import('../lib/batch-import/jobs'));
  store = await import('../lib/auth/store'); iron = await import('iron-session');
  sessionRegistry = (await import('../lib/auth/session-registry')).sessionRegistry;
  workStorage = await import('next/dist/server/app-render/work-async-storage.external');
  requestStorage = await import('next/dist/server/app-render/work-unit-async-storage.external');
  nextCookies = await import('next/dist/server/web/spec-extension/cookies');
  create = await import('../app/api/batch-import/jobs/route'); item = await import('../app/api/batch-import/jobs/[id]/route'); plan = await import('../app/api/batch-import/jobs/[id]/plan/route'); apply = await import('../app/api/batch-import/jobs/[id]/apply/route'); candidates = await import('../app/api/batch-import/jobs/[id]/candidates/route'); http = await import('../lib/batch-import/http');
  receipt = await import('../app/api/batch-import/jobs/[id]/receipt/route');
  const hash = await store.hashPassword('synthetic-password');
  fixture = { version: 1, admin: { id: 'admin', username: 'admin', passwordHash: hash }, primary: { id: 'primary', username: 'operator', passwordHash: hash, version: 1 } };
  userCookie = await seal({ authenticated: true, userId: 'primary', role: 'user', authVersion: 1 });
  const { accountVersion } = await import('../lib/auth/authorization');
  adminCookie = await seal({ authenticated: true, userId: 'admin', role: 'admin', authVersion: accountVersion(fixture.admin!) });
});
beforeEach(async () => {
  jobs.clear(); await store.updateAuth(() => structuredClone(fixture));
  userCookie = await seal({ authenticated: true, userId: 'primary', role: 'user', authVersion: 1 });
  await prisma.$transaction(async (tx) => { await tx.person.deleteMany(); await tx.importReceipt.deleteMany(); });
});
after(async () => { sessionRegistry?.revoke(); if (prisma) await prisma.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function seal(data: SessionData) {
  if (data.authenticated) {
    // Reseal the active identity to exercise cookie-bound draft isolation without
    // inventing two simultaneous logins in the single-session server model.
    const current = { ...data, sessionId: activeFixtureId };
    data.sessionId = sessionRegistry.isActive(current) ? activeFixtureId : sessionRegistry.register(data);
    activeFixtureId = data.sessionId;
  }
  return iron.sealData(data, { password: secret });
}
async function context<T>(cookie: string, task: () => Promise<T>): Promise<T> {
  const jar = new nextCookies.ResponseCookies(new Headers()); jar.set('tdb_session', cookie);
  const work = { isStaticGeneration: false, route: '/api/batch-import/test', page: '/api/batch-import/test/route' } as WorkStore;
  const req = { type: 'request', phase: 'action', cookies: jar, userspaceMutableCookies: jar, mutableCookies: jar } as unknown as RequestStore;
  return workStorage.workAsyncStorage.run(work, () => requestStorage.workUnitAsyncStorage.run(req, task));
}
function request(path: string, cookie: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`http://localhost${path}`, { method, headers: { cookie: `tdb_session=${cookie}`, origin: 'http://localhost', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function upload(): Promise<JobView> {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Люди'); sheet.addRows([['ФИО', 'Телефон'], ['Иванов Иван Иванович', '+70000000000']]);
  const body = new FormData(); body.append('files', new Blob([new Uint8Array(await book.xlsx.writeBuffer())]), 'people.xlsx');
  const response = await context(userCookie, () => create.POST(new Request('http://localhost/api/batch-import/jobs', { method: 'POST', headers: { cookie: `tdb_session=${userCookie}`, origin: 'http://localhost' }, body })));
  assert.equal(response.status, 201); return response.json();
}
test('real API upload, preview, explicit confirmation and durable repeat work end to end', async () => {
  let job = await upload(); assert.equal(await prisma.person.count(), 0);
  const response = await context(userCookie, () => plan.POST(request('', userCookie, { revision: job.revision, tables: job.tables.map((t) => t.selection) }), params(job.id)));
  assert.equal(response.status, 200); job = await response.json(); assert.equal(job.plan!.ready, 1); assert.equal(await prisma.person.count(), 0);
  const unsent = await context(userCookie, () => receipt.GET(request(`/?version=${job.revision}`, userCookie), params(job.id)));
  assert.equal(unsent.status, 404); assert.equal(await prisma.person.count(), 0); assert.equal(await prisma.importReceipt.count(), 0);
  const denied = await context(userCookie, () => apply.POST(request('', userCookie, { version: job.revision, confirm: false }), params(job.id)));
  assert.equal(denied.status, 400); assert.equal(await prisma.person.count(), 0);
  const saved = await context(userCookie, () => apply.POST(request('', userCookie, { version: job.revision, confirm: true }), params(job.id)));
  assert.equal(saved.status, 200); const result = await saved.json(); assert.equal(result.created, 1);
  jobs.clear();
  const readOnly = await context(userCookie, () => receipt.GET(request(`/?version=${job.revision}`, userCookie), params(job.id)));
  assert.equal(readOnly.status, 200); assert.deepEqual(await readOnly.json(), result);
  const repeated = await context(userCookie, () => apply.POST(request('', userCookie, { version: job.revision, confirm: true }), params(job.id)));
  assert.deepEqual(await repeated.json(), result); assert.equal(await prisma.person.count(), 1);
});
test('all API handlers return the actual authorization Response for unauthenticated/admin users', async () => {
  for (const [cookie, expected] of [[await seal({}), 401], [adminCookie, 403]] as const) {
    const calls = [() => create.POST(request('', cookie, {})), () => item.GET(request('', cookie), params('missing')), () => item.DELETE(request('', cookie, undefined, 'DELETE'), params('missing')), () => plan.POST(request('', cookie, {}), params('missing')), () => apply.POST(request('', cookie, {}), params('missing')), () => receipt.GET(request('/?version=1', cookie), params('missing')), () => candidates.GET(request('', cookie), params('missing')), () => candidates.POST(request('', cookie, {}), params('missing'))];
    for (const task of calls) assert.equal((await context(cookie, task)).status, expected);
  }
  const response = Response.json({ error: 'denied' }, { status: 423 }); assert.equal(http.importResponse(response), response);
});
test('drafts are isolated between login cookies and cannot be arbitrarily rewritten', async () => {
  const job = await upload();
  const other = await seal({ authenticated: true, userId: 'primary', role: 'user', authVersion: 1 });
  assert.equal((await context(other, () => item.GET(request('', other), params(job.id)))).status, 404);
  assert.equal((await context(userCookie, () => plan.POST(request('', userCookie, { revision: job.revision, rowEdits: [{ rowId: 'forged', values: { lastName: 'Иванов' } }] }), params(job.id)))).status, 400);
  assert.equal((await context(userCookie, () => plan.POST(request('', userCookie, { revision: job.revision, rowEdits: [{ rowId: `${job.tables[0].id}:row:2`, values: { deletedAt: '2020-01-01' } }] }), params(job.id)))).status, 400);
  const crossSite = new Request('http://localhost/api/batch-import/jobs', { method: 'POST', headers: { origin: 'https://other.example', cookie: `tdb_session=${userCookie}` } });
  assert.equal((await context(userCookie, () => create.POST(crossSite))).status, 403); assert.equal(await prisma.person.count(), 0);
});
test('manual candidate search includes archives; registration enables only that validated person', async () => {
  const existing = await prisma.person.create({ data: { lastName: 'Сидоров', firstName: 'Пётр', deletedAt: new Date('2025-01-01') } });
  let job = await upload();
  const search = await context(userCookie, () => candidates.GET(request('/?q=Сидоров', userCookie), params(job.id)));
  const found = await search.json(); assert.equal(found.items[0].id, existing.id); assert.ok(found.items[0].deletedAt);
  const computed = await context(userCookie, () => plan.POST(request('', userCookie, { revision: job.revision }), params(job.id))); job = await computed.json();
  const registered = await context(userCookie, () => candidates.POST(request('', userCookie, { revision: job.revision, personId: existing.id }), params(job.id))); job = await registered.json();
  const picked = await context(userCookie, () => plan.POST(request('', userCookie, { revision: job.revision, decisions: [{ groupId: job.plan!.groups[0].id, action: 'existing', personId: existing.id, fields: { lastName: null, firstName: null } }] }), params(job.id)));
  assert.equal(picked.status, 200); job = await picked.json(); assert.equal(job.plan!.groups[0].target!.id, existing.id); assert.equal(job.plan!.blocked, 0);
  assert.equal((await context(userCookie, () => item.DELETE(request('', userCookie, undefined, 'DELETE'), params(job.id)))).status, 204);
  assert.equal((await context(userCookie, () => item.GET(request('', userCookie), params(job.id)))).status, 404);
});
test('request body limits and schema validation reject oversized and forged payloads', async () => {
  await assert.rejects(http.boundedBody(new Request('http://localhost', { method: 'POST', body: '12345' }), 4), /предел/);
  assert.equal(http.applyRequestSchema.safeParse({ version: 1, confirm: true, personId: 'forged' }).success, false);
  assert.equal(http.planRequestSchema.safeParse({ revision: 1, decisions: [{ groupId: 'group', action: 'existing', fields: { id: 'forged' } }] }).success, false);
});
