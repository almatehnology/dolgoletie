import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monitorSessionActivity, SESSION_LEAVING_EVENT } from '../lib/auth/activity-monitor';
import { clearClientSession, expireClientSession, leaveAccount } from '../lib/auth/client';
import { makeStore } from '../lib/store';
import { api } from '../lib/store/api';
import { openSearchModal, toggleScansRevealed, pushToast } from '../lib/store/ui-slice';

class InputTarget extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) { const values = this.listeners.get(type) ?? new Set(); values.add(listener); this.listeners.set(type, values); }
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  input(type = 'keydown', trusted = true) {
    const event = { isTrusted: trusted } as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event); else listener.handleEvent(event);
    }
  }
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('poll/focus/page restoration do not count as input; trusted visible input is throttled and cleanup removes timers', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const target = new InputTarget();
  const calls: string[] = [];
  let visible = true;
  let expired = 0;
  const stop = monitorSessionActivity({ role: 'user', target, visible: () => visible, onExpired: () => { expired++; }, request: async (path) => {
    calls.push(String(path));
    return Response.json({ authenticated: true, role: 'user', idleExpiresAt: Date.now() + 60_000 });
  } });
  t.after(stop);
  await settle();
  target.dispatchEvent(new Event('focus')); await settle();
  target.dispatchEvent(new Event('pageshow')); await settle();
  t.mock.timers.tick(15_000); await settle();
  assert.equal(calls.filter(path => path === '/api/auth/activity').length, 0);
  target.input('keydown', false); visible = false; target.input(); await settle();
  assert.equal(calls.filter(path => path === '/api/auth/activity').length, 0);
  visible = true; target.input(); await settle();
  target.input('pointermove'); await settle();
  assert.equal(calls.filter(path => path === '/api/auth/activity').length, 1);
  t.mock.timers.tick(10_000); target.input('wheel'); await settle();
  assert.equal(calls.filter(path => path === '/api/auth/activity').length, 2);
  const count = calls.length;
  stop(); t.mock.timers.tick(120_000); target.input(); await settle();
  assert.equal(calls.length, count);
  assert.equal(expired, 0);
});

test('only successful activity reschedules the local deadline; expiry still clears content while status is offline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const target = new InputTarget();
  let checks = 0;
  let expired = 0;
  const stop = monitorSessionActivity({ role: 'user', target, onExpired: () => { expired++; }, visible: () => true, request: async (path) => {
    if (path === '/api/auth/activity') return Response.json({ idleExpiresAt: Date.now() + 60_000 });
    if (++checks > 1) throw new Error('offline');
    return Response.json({ authenticated: true, role: 'user', idleExpiresAt: Date.now() + 60_000 });
  } });
  t.after(stop); await settle();
  t.mock.timers.tick(30_000); await settle();
  target.input(); await settle();
  t.mock.timers.tick(30_000); await settle(); assert.equal(expired, 0);
  t.mock.timers.tick(30_000); await settle(); assert.equal(expired, 1);
  target.input(); await settle(); assert.equal(expired, 1);
});

test('disabled expiry has no local deadline; mismatched role and unauthenticated responses end the monitor', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const target = new InputTarget();
  let role = 'admin';
  let expired = 0;
  const stop = monitorSessionActivity({ role: 'admin', target, onExpired: () => { expired++; }, request: async () => Response.json({ authenticated: true, role, idleExpiresAt: null }) });
  t.after(stop); await settle();
  t.mock.timers.tick(86_400_000); await settle(); assert.equal(expired, 0);
  role = 'user'; target.dispatchEvent(new Event('focus')); await settle(); assert.equal(expired, 1);
  const stopUser = monitorSessionActivity({ role: 'user', target: new InputTarget(), onExpired: () => { expired++; }, request: async () => Response.json({ authenticated: false, role: null, idleExpiresAt: null }) });
  t.after(stopUser); await settle(); assert.equal(expired, 2);
});

test('late status responses cannot overwrite a newer activity deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const target = new InputTarget();
  const pendingStatus = deferred<Response>();
  let expired = false;
  const stop = monitorSessionActivity({ role: 'user', target, visible: () => true, onExpired: () => { expired = true; }, request: async (path) => path === '/api/auth/status' ? pendingStatus.promise : Response.json({ idleExpiresAt: Date.now() + 120_000 }) });
  t.after(stop);
  target.input(); await settle();
  pendingStatus.resolve(Response.json({ authenticated: true, role: 'user', idleExpiresAt: Date.now() + 1_000 })); await settle();
  t.mock.timers.tick(1_001); await settle(); assert.equal(expired, false);
  t.mock.timers.tick(118_999); await settle(); assert.equal(expired, true);
});

test('explicit logout stops the monitor before its POST and ignores in-flight status/activity, preserving both destinations', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  });
  for (const destination of ['/login', '/login?role=admin']) {
    const target = new InputTarget();
    const redirects: string[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(target, { location: { replace: (path: string) => redirects.push(path) } }) });
    const status = deferred<Response>(), activity = deferred<Response>(), logout = deferred<Response>();
    const stop = monitorSessionActivity({ role: 'user', target, visible: () => true, onExpired: () => redirects.push('/login?expired=1'), request: async path => path === '/api/auth/status' ? status.promise : activity.promise });
    t.after(stop); target.input();
    let signalled = false;
    target.addEventListener(SESSION_LEAVING_EVENT, () => { signalled = true; });
    globalThis.fetch = async () => { assert.equal(signalled, true); return logout.promise; };
    const leaving = leaveAccount(makeStore(), destination);
    status.resolve(Response.json({ authenticated: false })); activity.resolve(Response.json({}, { status: 401 }));
    await settle(); t.mock.timers.tick(120_000); await settle();
    assert.deepEqual(redirects, []);
    logout.resolve(Response.json({ ok: true })); await leaving;
    assert.deepEqual(redirects, [destination]);
  }
});

test('expiry clears actual Redux queries, revealed scans, search/toasts and session storage before role-specific navigation', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const removed: string[] = [], actions: string[] = [];
  const store = makeStore();
  store.dispatch(openSearchModal()); store.dispatch(toggleScansRevealed('person')); store.dispatch(pushToast({ id: 'toast', kind: 'info', message: 'private' }));
  const queries = api.injectEndpoints({ endpoints: builder => ({ idlePrivateFixture: builder.query<string, void>({ queryFn: async () => ({ data: 'private' }) }) }) });
  await store.dispatch(queries.endpoints.idlePrivateFixture.initiate(undefined, { subscribe: false }));
  assert.ok(Object.keys(store.getState().api.queries).length);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    sessionStorage: { removeItem: (key: string) => { removed.push(key); } },
    location: { replace: (path: string) => { assert.deepEqual(store.getState().api.queries, {}); actions.push(path); } },
  } });
  t.after(() => { clearClientSession(store); if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window'); });
  expireClientSession(store, 'admin');
  assert.equal(store.getState().ui.searchModalOpen, false);
  assert.equal(store.getState().ui.scansRevealedFor.person, false);
  assert.deepEqual(store.getState().ui.toasts, []);
  assert.deepEqual(removed, ['tdb-batch-import', 'tdb-batch-import-confirmation']);
  assert.deepEqual(actions, ['/login?role=admin&expired=1']);
  expireClientSession(store, 'user'); assert.equal(actions.at(-1), '/login?expired=1');
});
