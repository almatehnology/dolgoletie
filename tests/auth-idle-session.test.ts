import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdleSessionRegistry } from '../lib/auth/idle-session';
import type { SessionData } from '../lib/auth/types';

const identity = (): SessionData => ({ authenticated: true, role: 'user', userId: 'operator', authVersion: 1 });
function fixture() {
  let now = 0;
  let callback: (() => void) | undefined;
  let locks = 0;
  const registry = new IdleSessionRegistry(() => { locks++; }, {
    now: () => now,
    schedule: (fn) => { callback = fn; return 1 as unknown as ReturnType<typeof setTimeout>; },
    cancel: () => { callback = undefined; },
  });
  const session = identity();
  session.sessionId = registry.register(session);
  return { registry, session, advance: (ms: number) => { now += ms; }, fire: () => callback?.(), locks: () => locks };
}

test('default 15 minutes expires by server timer with no requests and cannot be revived by activity', () => {
  const f = fixture();
  f.advance(15 * 60_000); f.fire();
  assert.equal(f.locks(), 1);
  assert.equal(f.registry.isActive(f.session), false);
  assert.equal(f.registry.touch(f.session), false);
  f.fire(); assert.equal(f.locks(), 1);
});

test('guard-time expiry works with a delayed timer; polling never refreshes last activity', () => {
  const f = fixture();
  const deadline = f.registry.status(f.session).idleExpiresAt;
  for (let i = 0; i < 15; i++) {
    assert.equal(f.registry.isActive(f.session), true);
    assert.equal(f.registry.status(f.session).idleExpiresAt, deadline);
    f.advance(60_000);
  }
  assert.equal(f.registry.isActive(f.session), false);
  assert.equal(f.locks(), 1);
});

test('activity extends the deadline, while configuring only changes duration relative to last input', () => {
  const f = fixture();
  f.advance(60_000);
  assert.equal(f.registry.touch(f.session), true);
  assert.equal(f.registry.status(f.session).idleExpiresAt, 16 * 60_000);
  f.advance(60_000);
  f.registry.configure(2);
  assert.equal(f.registry.status(f.session).idleExpiresAt, 3 * 60_000);
  f.advance(60_000); f.fire();
  assert.equal(f.registry.isActive(f.session), false);
});

test('disable cancels expiry; re-enable and shorten expire against original activity, with strict bounds', () => {
  const f = fixture();
  f.registry.configure(null);
  f.advance(1441 * 60_000); f.fire();
  assert.equal(f.registry.isActive(f.session), true);
  assert.equal(f.registry.status(f.session).idleExpiresAt, null);
  for (const value of [0, -1, 1.5, 1441, NaN]) assert.throws(() => f.registry.configure(value));
  f.registry.configure(1440);
  assert.equal(f.registry.isActive(f.session), false);
  assert.equal(f.locks(), 1);
});

test('new login revokes every previous ID, missing/forged IDs fail, and a process restart forgets cookies', () => {
  const f = fixture();
  assert.equal(f.registry.isActive(identity()), false);
  assert.equal(f.registry.isActive({ ...f.session, sessionId: 'forged' }), false);
  assert.equal(f.registry.isActive({ ...f.session, role: 'admin' }), false);
  const next = identity(); next.sessionId = f.registry.register(next);
  assert.notEqual(next.sessionId, f.session.sessionId);
  assert.equal(f.registry.isActive(f.session), false);
  assert.equal(f.registry.isActive(next), true);
  assert.equal(new IdleSessionRegistry(() => {}).isActive(next), false);
  f.registry.revoke(); assert.equal(f.registry.isActive(next), false);
});
