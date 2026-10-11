import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { installLockLifecycle } = require('../desktop/lifecycle.cjs');
const origin = 'http://127.0.0.1:43127';
const token = 'e'.repeat(64);

test('OS lock/suspend uses a private authenticated logout with known Origin and never auto-unlocks', async () => {
  const powerMonitor = new EventEmitter();
  const calls: any[] = [];
  const lifecycle = installLockLifecycle({ powerMonitor, origin, token,
    privateSession: { fetch: async (url: string, options: any) => { calls.push({ url, options }); return { ok: true, body: { cancel: async () => calls.push('response closed') } }; } },
    revokeFiles: async () => calls.push('files revoked'), navigateLogin: async (url: string) => calls.push(url),
    failClosed: () => assert.fail('successful logout must not quit'),
  });
  try {
    assert.equal(powerMonitor.listenerCount('unlock-screen'), 0);
    assert.equal(powerMonitor.listenerCount('resume'), 0);
    powerMonitor.emit('lock-screen');
    await lifecycle.lock();
    assert.equal(calls[0].url, `${origin}/api/auth/logout`);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.credentials, 'include');
    assert.equal(calls[0].options.redirect, 'error');
    assert.deepEqual(calls[0].options.headers, { Origin: origin, 'x-tdb-desktop-token': token });
    assert.deepEqual(calls.slice(1), ['response closed', 'files revoked', `${origin}/login`]);
    const before = calls.length;
    powerMonitor.emit('unlock-screen'); powerMonitor.emit('resume');
    await new Promise((done) => setImmediate(done));
    assert.equal(calls.length, before);
    powerMonitor.emit('suspend'); await lifecycle.lock();
    assert.equal(calls.length, before * 2);
  } finally { lifecycle.dispose(); }
  assert.equal(powerMonitor.listenerCount('lock-screen'), 0);
  assert.equal(powerMonitor.listenerCount('suspend'), 0);
});

test('overlapping OS signals coalesce and failed logout quits instead of leaving keys unlocked', async () => {
  const powerMonitor = new EventEmitter();
  let fetches = 0; let quits = 0; let navigations = 0;
  let reply!: (result: any) => void;
  const lifecycle = installLockLifecycle({ powerMonitor, origin, token,
    privateSession: { fetch: () => { fetches++; return new Promise((done) => { reply = done; }); } },
    revokeFiles: async () => {}, navigateLogin: async () => { navigations++; }, failClosed: async () => { quits++; },
  });
  try {
    powerMonitor.emit('lock-screen'); powerMonitor.emit('suspend');
    const waiting = lifecycle.lock();
    assert.equal(fetches, 1);
    reply({ ok: false }); await waiting;
    assert.equal(quits, 1); assert.equal(navigations, 0);
  } finally { lifecycle.dispose(); }
});

test('hung logout aborts promptly and quitting/disposal cannot start another control request', async () => {
  const powerMonitor = new EventEmitter();
  let quits = 0; let fetches = 0; let quitting = false;
  const lifecycle = installLockLifecycle({ powerMonitor, origin, token, timeoutMs: 10, isQuitting: () => quitting,
    privateSession: { fetch: (_url: string, { signal }: any) => { fetches++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); } },
    revokeFiles: async () => {}, navigateLogin: () => assert.fail('timeout cannot navigate'), failClosed: async () => { quits++; },
  });
  await lifecycle.lock();
  assert.equal(quits, 1); assert.equal(fetches, 1);
  quitting = true; powerMonitor.emit('suspend'); await lifecycle.lock();
  assert.equal(fetches, 1);
  lifecycle.dispose(); quitting = false; await lifecycle.lock();
  assert.equal(fetches, 1);
});
