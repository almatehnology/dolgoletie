'use strict';

// Test entrypoint only. It is never included in the production app package.
const { app, dialog, utilityProcess, BrowserWindow, session } = require('electron');
const { join, dirname } = require('node:path');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const root = process.env.TDB_DESKTOP_QA_ROOT || process.argv[2];
const entry = process.env.TDB_DESKTOP_QA_ENTRY || process.argv[3] || join(__dirname, 'main.cjs');
if (!root) throw new Error('An isolated desktop acceptance root is required');
app.setPath('appData', join(root, 'app-data'));
// Acceptance must not interrupt the owner's desktop or open a real native panel.
// Install these before production main can create a window or wire any IPC.
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};

const state = globalThis.__desktopAcceptance = {
  workers: [], startupErrors: [], dialogs: [], redirects: [], runtime: null,
  originalOpen: dialog.showOpenDialog.bind(dialog), originalSave: dialog.showSaveDialog.bind(dialog),
};
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
dialog.showSaveDialog = async () => ({ canceled: true });
const fork = utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork = (path, args, options) => {
  const child = fork(path, args, options);
  const worker = { pid: null, exited: false, code: null, root: args[0] };
  state.workers.push(worker);
  state.token = options.env.DESKTOP_LAUNCH_TOKEN;
  child.on('spawn', () => { worker.pid = child.pid; });
  child.on('message', (message) => {
    if (message.type === 'runtime') state.runtime = message;
    if (message.type === 'startup-error') state.startupErrors.push(message.message);
  });
  child.on('exit', (code) => {
    worker.exited = true; worker.code = code;
    console.log(`DESKTOP_WORKER_EXIT=${JSON.stringify(worker)}`);
  });
  return child;
};
state.requestStatus = (origin, headers = {}) => new Promise((resolve, reject) => {
  http.get(origin, { headers: { 'x-tdb-desktop-token': state.token, ...headers } }, (response) => {
    response.resume(); response.on('end', () => resolve(response.statusCode));
  }).on('error', reject);
});
state.testControlNetwork = async () => {
  const { installLockLifecycle } = require(join(dirname(entry), 'lifecycle.cjs'));
  const { trustedRequest } = require(join(dirname(entry), 'server-boundary.cjs'));
  const token = randomBytes(32).toString('hex');
  const records = [];
  const navigations = [];
  let origin;
  const server = http.createServer((request, response) => {
    const valid = trustedRequest(request, origin, token) && request.url === '/api/auth/logout' &&
      request.method === 'POST' && request.headers.origin === origin && request.headers.cookie === 'tdb_control=synthetic-private-cookie';
    records.push({ method: request.method, path: request.url, origin: request.headers.origin, tokenMatched: request.headers['x-tdb-desktop-token'] === token, privateCookieMatched: request.headers.cookie === 'tdb_control=synthetic-private-cookie' });
    response.writeHead(valid ? 200 : 403, { 'Content-Type': 'application/json', 'Set-Cookie': 'tdb_control=; Path=/; Max-Age=0' });
    response.end('{"ok":true}');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const ses = session.fromPartition(`tdb-control-${randomBytes(16).toString('hex')}`, { cache: false });
  const monitor = new EventEmitter();
  let failed = false;
  const lifecycle = installLockLifecycle({ powerMonitor: monitor, privateSession: ses, origin, token,
    revokeFiles: async () => {}, navigateLogin: async (url) => { navigations.push(url); }, failClosed: () => { failed = true; },
  });
  try {
    await ses.cookies.set({ url: origin, name: 'tdb_control', value: 'synthetic-private-cookie', httpOnly: true, sameSite: 'strict' });
    monitor.emit('lock-screen'); monitor.emit('suspend'); await lifecycle.lock();
    monitor.emit('unlock-screen'); monitor.emit('resume');
    await new Promise((done) => setImmediate(done));
    return { records, navigations, failed, remainingCookies: (await ses.cookies.get({ url: origin })).length,
      unlockListeners: monitor.listenerCount('unlock-screen'), resumeListeners: monitor.listenerCount('resume') };
  } finally {
    lifecycle.dispose(); await ses.clearStorageData();
    await new Promise((done) => { server.close(done); server.closeAllConnections(); });
  }
};
dialog.showErrorBox = (title, message) => {
  state.startupErrors.push(`${title}: ${message}`);
  console.error(`DESKTOP_ERROR=${title}: ${message}`);
};
const loadURL = BrowserWindow.prototype.loadURL;
BrowserWindow.prototype.loadURL = function (url, ...args) {
  this.webContents.on('will-redirect', (_event, target) => {
    state.redirects.push(target); console.log(`DESKTOP_REDIRECT=${target}`);
  });
  if (process.env.TDB_DESKTOP_QA_START_SETUP === '1' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) url = `${url.replace(/\/$/, '')}/setup`;
  return loadURL.call(this, url, ...args);
};
require(entry);
