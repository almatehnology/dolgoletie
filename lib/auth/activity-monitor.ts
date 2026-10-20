import type { AuthRole } from './types';

export const SESSION_LEAVING_EVENT = 'tdb:session-leaving';

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
const REPORT_INTERVAL_MS = 10_000;
const STATUS_INTERVAL_MS = 15_000;

/** Polling observes expiry; only trusted, visible user input reports activity. */
export function monitorSessionActivity(options: {
  role: AuthRole;
  onExpired(): void;
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  visible?: () => boolean;
  request?: typeof fetch;
}): () => void {
  const target = options.target ?? window;
  const visible = options.visible ?? (() => document.visibilityState !== 'hidden');
  const request = options.request ?? fetch;
  let stopped = false;
  let checking = false;
  let reporting = false;
  let lastReport = -Infinity;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let observedDeadline: number | null = null;
  let activityRevision = 0;

  function expire() {
    if (stopped) return;
    stop();
    options.onExpired();
  }

  function applyDeadline(deadline: number | null) {
    observedDeadline = deadline;
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = deadline === null ? undefined : setTimeout(expire, Math.max(0, deadline - Date.now()));
  }

  async function check() {
    if (stopped || checking) return;
    checking = true;
    const revision = activityRevision;
    try {
      const response = await request('/api/auth/status', { cache: 'no-store' });
      if (stopped) return;
      if (response.status === 401 || response.status === 423) { expire(); return; }
      if (!response.ok) return;
      const status = await response.json();
      if (stopped) return;
      if (!status.authenticated || status.role !== options.role) { expire(); return; }
      // An older status response must not shorten a just-refreshed activity deadline.
      if (revision === activityRevision && (status.idleExpiresAt === null || typeof status.idleExpiresAt === 'number')) applyDeadline(status.idleExpiresAt);
    } catch { /* The last known deadline still clears private content while offline. */ }
    finally { checking = false; }
  }

  async function activity(event: Event) {
    if (stopped || !event.isTrusted || !visible() || reporting || Date.now() - lastReport < REPORT_INTERVAL_MS) return;
    if (observedDeadline !== null && Date.now() >= observedDeadline) { expire(); return; }
    reporting = true;
    lastReport = Date.now();
    activityRevision++;
    try {
      const response = await request('/api/auth/activity', { method: 'POST', cache: 'no-store' });
      if (stopped) return;
      if (response.status === 401 || response.status === 423) { expire(); return; }
      if (!response.ok) return;
      const status = await response.json();
      if (!stopped && (status.idleExpiresAt === null || typeof status.idleExpiresAt === 'number')) applyDeadline(status.idleExpiresAt);
    } catch { /* Input cannot revive a server session once it has expired. */ }
    finally { reporting = false; }
  }

  function onFocus() { void check(); }
  for (const name of ACTIVITY_EVENTS) target.addEventListener(name, activity, { passive: true });
  target.addEventListener('focus', onFocus);
  target.addEventListener('pageshow', onFocus);
  target.addEventListener(SESSION_LEAVING_EVENT, stop);
  const interval = setInterval(() => { void check(); }, STATUS_INTERVAL_MS);
  function stop() {
    stopped = true;
    clearInterval(interval);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    for (const name of ACTIVITY_EVENTS) target.removeEventListener(name, activity);
    target.removeEventListener('focus', onFocus);
    target.removeEventListener('pageshow', onFocus);
    target.removeEventListener(SESSION_LEAVING_EVENT, stop);
  }
  void check();
  return stop;
}
