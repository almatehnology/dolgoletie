'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, utilityProcess, Menu, powerMonitor } = require('electron');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { FileBroker } = require('./files.cjs');
const { launchServer } = require('./runtime.cjs');
const { TOKEN_HEADER } = require('./server-boundary.cjs');
const { CHANNELS, sameOrigin, validateSender } = require('./validation.cjs');
const { installLockLifecycle } = require('./lifecycle.cjs');

app.setName('TravelDataBase');
app.setPath('userData', join(app.getPath('appData'), 'TravelDataBase'));
app.enableSandbox();

let window;
let server;
let broker;
let expiryTimer;
let lockLifecycle;
let quitting = false;
let quitComplete = false;

function assertSender(event) {
  if (quitting || !window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('Окно недоступно');
  validateSender({
    senderId: event.sender.id,
    expectedSenderId: window.webContents.id,
    isMainFrame: !!event.senderFrame && event.senderFrame === window.webContents.mainFrame,
    frameUrl: event.senderFrame?.url,
    origin: server.origin,
  });
}

function wireFiles() {
  broker = new FileBroker({
    selectDialog: async (kind) => {
      const result = await dialog.showOpenDialog(window, {
        title: kind === 'tables' ? 'Открыть таблицы DOCX/XLSX' : 'Открыть файл обмена',
        properties: kind === 'tables' ? ['openFile', 'multiSelections', 'dontAddToRecent'] : ['openFile', 'dontAddToRecent'],
        filters: [{ name: kind === 'tables' ? 'Таблицы DOCX/XLSX' : 'Файл обмена', extensions: kind === 'tables' ? ['docx', 'xlsx'] : ['zip', 'tdbsync'] }],
      });
      return result.canceled ? null : result.filePaths;
    },
    saveDialog: async (filename) => {
      const result = await dialog.showSaveDialog(window, {
        title: 'Сохранить файл', defaultPath: join(app.getPath('documents'), filename),
        properties: ['showOverwriteConfirmation', 'dontAddToRecent', 'createDirectory'],
        filters: [{ name: 'Файл', extensions: [filename.split('.').pop().toLowerCase()] }],
      });
      return result.canceled ? null : result.filePath || null;
    },
  });
  const methods = { select: 'select', read: 'read', release: 'release', beginSave: 'beginSave', write: 'write', commit: 'commit', abort: 'abort' };
  for (const [name, method] of Object.entries(methods)) {
    ipcMain.handle(CHANNELS[name], async (event, payload, ...extra) => {
      assertSender(event);
      if (extra.length) throw new Error('Лишние аргументы IPC');
      try { return await broker[method](payload, () => assertSender(event)); }
      catch (error) {
        // Avoid disclosing a user-selected absolute path through fs error messages.
        if (error.code) throw new Error(`Файловая операция не выполнена (${error.code})`);
        throw error;
      }
    });
  }
  expiryTimer = setInterval(() => {
    if (!broker.active && !broker.invalidating) void broker.operation(() => {}, async () => {}).catch(() => {});
  }, 30_000);
  expiryTimer.unref();
}

function privateSession(origin, token) {
  const ses = session.fromPartition(`tdb-${randomUUID()}`, { cache: false });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = sameOrigin(details.url, origin) ||
      (details.resourceType === 'image' && details.url.startsWith('data:image/')) ||
      (details.url.startsWith('blob:') && sameOrigin(details.url.slice(5), origin));
    callback({ cancel: !allowed });
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === TOKEN_HEADER) delete headers[key];
    if (sameOrigin(details.url, origin)) headers[TOKEN_HEADER] = token;
    callback({ requestHeaders: headers });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (['content-security-policy', 'x-frame-options', 'x-content-type-options'].includes(key.toLowerCase())) delete headers[key];
    }
    headers['Content-Security-Policy'] = [
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; " +
      "frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ];
    headers['X-Frame-Options'] = ['DENY'];
    headers['X-Content-Type-Options'] = ['nosniff'];
    callback({ responseHeaders: headers });
  });
  return ses;
}

async function start() {
  const standalone = app.isPackaged ? join(process.resourcesPath, 'next') : join(__dirname, 'stage', 'next');
  server = await launchServer({ utilityProcess, userData: app.getPath('userData'), standalone, worker: join(__dirname, 'server-worker.cjs') });
  if (quitting) { await server.stop(); return; }
  window = new BrowserWindow({
    title: 'TravelDataBase', width: 1280, height: 850, minWidth: 800, minHeight: 600, show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'), session: privateSession(server.origin, server.token),
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, safeDialogs: true, devTools: false,
    },
  });
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
  ]) : Menu.buildFromTemplate([{ role: 'editMenu' }]));
  wireFiles();
  lockLifecycle = installLockLifecycle({
    powerMonitor, privateSession: window.webContents.session, origin: server.origin, token: server.token,
    navigateLogin: (url) => window.loadURL(url), revokeFiles: () => broker.revoke(),
    isQuitting: () => quitting,
    failClosed: () => app.quit(),
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!sameOrigin(url, server.origin)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!sameOrigin(url, server.origin)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) void broker.revoke().catch(() => {});
  });
  window.webContents.on('render-process-gone', () => {
    if (quitting) return;
    void broker.revoke().catch(() => {});
    dialog.showErrorBox('TravelDataBase', 'Окно приложения завершилось. Перезапустите приложение.');
    app.quit();
  });
  window.on('closed', () => app.quit());
  server.onExit(() => {
    if (!quitting) {
      dialog.showErrorBox('TravelDataBase', 'Локальный процесс данных завершился. Перезапустите приложение.');
      app.quit();
    }
  });
  await window.loadURL(server.origin);
  if (!quitting && !window.isDestroyed()) window.show();
}

app.on('before-quit', (event) => {
  if (quitComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  lockLifecycle?.dispose();
  clearInterval(expiryTimer);
  if (window && !window.isDestroyed()) window.destroy();
  void (async () => {
    await broker?.revoke().catch(() => {
      dialog.showErrorBox('TravelDataBase', 'Не удалось удалить временный файл экспорта. Проверьте выбранный носитель.');
    });
    try { await server?.stop(); }
    catch {
      dialog.showErrorBox('TravelDataBase', 'Не удалось завершить локальный процесс данных. Проверьте процессы приложения.');
    } finally {
      quitComplete = true;
      app.quit();
    }
  })();
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  });
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('Не удалось запустить TravelDataBase', String(error.message));
    app.quit();
  });
}
