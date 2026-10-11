'use strict';

const { validOrigin } = require('./validation.cjs');
const { TOKEN_HEADER } = require('./server-boundary.cjs');

/** Main-only OS control: no renderer IPC, script execution or backend bypass. */
function installLockLifecycle({ powerMonitor, privateSession, origin, token, navigateLogin, revokeFiles, failClosed, isQuitting = () => false, timeoutMs = 5000 }) {
  if (!validOrigin(origin) || !/^[a-f0-9]{64}$/u.test(token || '')) throw new Error('Invalid desktop control origin/token');
  let pending;
  let disposed = false;
  const lock = () => {
    if (disposed || isQuitting()) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // The token/Origin are explicit: Session.fetch may not run webRequest hooks.
        // credentials: include uses this window's private in-memory cookie session.
        const response = await privateSession.fetch(`${origin}/api/auth/logout`, {
          method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error',
          headers: { Origin: origin, [TOKEN_HEADER]: token }, signal: controller.signal,
        });
        if (!response.ok) throw new Error('Desktop lock logout failed');
        await response.body?.cancel();
        await revokeFiles();
        if (!disposed && !isQuitting()) await navigateLogin(`${origin}/login`);
      } catch (error) {
        // If HTTP cleanup fails, quitting terminates the owned data worker and keys.
        if (!disposed && !isQuitting()) await failClosed(error);
      } finally { clearTimeout(timer); }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const onLock = () => { void lock(); };
  powerMonitor.on('lock-screen', onLock);
  powerMonitor.on('suspend', onLock);
  // Intentionally no resume/unlock-screen handlers: unlocking needs a fresh login.
  return {
    lock,
    dispose() {
      disposed = true;
      powerMonitor.removeListener('lock-screen', onLock);
      powerMonitor.removeListener('suspend', onLock);
    },
  };
}

module.exports = { installLockLifecycle };
