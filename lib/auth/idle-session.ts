import { randomUUID } from 'node:crypto';
import type { SessionData } from './types';
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from './security-settings';

type ActiveSession = Required<Pick<SessionData, 'sessionId' | 'userId' | 'role' | 'authVersion'>> & { lastActivityAt: number };
type Clock = {
  now(): number;
  schedule(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
};
const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timer.unref?.(); return timer; },
  cancel: (timer) => clearTimeout(timer),
};

/** One process owns the local vault and one active login, across both roles. */
export class IdleSessionRegistry {
  private active?: ActiveSession;
  private timer?: ReturnType<typeof setTimeout>;
  private minutes: number | null = DEFAULT_IDLE_TIMEOUT_MINUTES;
  private revision = 0;

  constructor(private readonly onExpire: (revision: number) => void, private readonly clock: Clock = systemClock) {}

  get generation(): number { return this.revision; }

  register(session: SessionData): string {
    if (!session.authenticated || !session.userId || !session.role || session.authVersion === undefined) throw new Error('Missing session identity');
    this.revoke();
    const sessionId = randomUUID();
    this.active = { sessionId, userId: session.userId, role: session.role, authVersion: session.authVersion, lastActivityAt: this.clock.now() };
    this.arm();
    return sessionId;
  }

  revoke(): void {
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined;
    this.active = undefined;
    this.revision++;
  }

  configure(minutes: number | null): void {
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) throw new Error('Invalid idle timeout');
    this.minutes = minutes;
    if (!this.expireIfDue()) this.arm();
  }

  isActive(session: SessionData): boolean {
    this.expireIfDue();
    const active = this.active;
    return Boolean(active && session.authenticated === true && session.sessionId === active.sessionId && session.userId === active.userId && session.role === active.role && session.authVersion === active.authVersion);
  }

  touch(session: SessionData): boolean {
    if (!this.isActive(session)) return false;
    this.active!.lastActivityAt = this.clock.now();
    this.arm();
    return true;
  }

  status(session: SessionData): { idleTimeoutMinutes: number | null; idleExpiresAt: number | null } {
    const live = this.isActive(session);
    return { idleTimeoutMinutes: this.minutes, idleExpiresAt: live && this.minutes !== null ? this.active!.lastActivityAt + this.minutes * 60_000 : null };
  }

  private expireIfDue(): boolean {
    if (!this.active || this.minutes === null || this.clock.now() < this.active.lastActivityAt + this.minutes * 60_000) return false;
    // Revoke synchronously: even a delayed timer/queued vault transition cannot admit a stale request.
    this.revoke();
    this.onExpire(this.revision);
    return true;
  }

  private arm(): void {
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined;
    if (!this.active || this.minutes === null) return;
    const generation = this.revision;
    this.timer = this.clock.schedule(() => {
      if (generation !== this.revision) return;
      if (!this.expireIfDue()) this.arm();
    }, Math.max(1, this.active.lastActivityAt + this.minutes * 60_000 - this.clock.now()));
  }
}
