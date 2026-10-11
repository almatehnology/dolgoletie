'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, readdir, cp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { createHash } = require('node:crypto');
const http = require('node:http');
const { _electron } = require('@playwright/test');

const repo = resolve(__dirname, '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const requestStatus = (url) => new Promise((done, reject) => {
  http.get(url, (response) => { response.resume(); response.on('end', () => done(response.statusCode)); }).on('error', reject);
});

async function main() {
  if (process.argv.includes('--native-dialogs')) throw new Error('Visible native dialogs are disabled by owner instruction. Acceptance uses hidden windows and dialog stubs only.');
  const root = await mkdtemp(join(tmpdir(), 'tdb-desktop-acceptance-'));
  console.log(`DESKTOP_QA_ARTIFACTS=${root}`);
  const screenshots = join(root, 'screenshots');
  const fixtures = join(root, 'Тестовые файлы с пробелами');
  await mkdir(screenshots); await mkdir(fixtures); await mkdir(join(root, 'app-data'));
  const evidence = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, checks: {}, root };
  const env = { ...process.env, TDB_DESKTOP_QA_ROOT: root, TDB_DESKTOP_QA_ENTRY: join(repo, 'desktop', 'main.cjs') };
  if (process.argv.includes('--start-setup')) {
    env.TDB_DESKTOP_QA_START_SETUP = '1';
    evidence.initialNavigationOverride = '/setup (test harness only; production root redirect is not accepted)';
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  let executablePath;
  let copiedBundle;
  let args = [join(__dirname, 'desktop-harness.cjs'), root, join(repo, 'desktop', 'main.cjs')];
  const packagedIndex = process.argv.indexOf('--packaged');
  if (packagedIndex !== -1) {
    if (process.platform !== 'darwin') throw new Error('--packaged currently accepts a macOS .app bundle');
    const source = resolve(process.argv[packagedIndex + 1]);
    const copy = join(root, basename(source));
    copiedBundle = copy;
    await cp(source, copy, { recursive: true, verbatimSymlinks: true });
    const resources = join(copy, 'Contents', 'Resources');
    const shell = join(resources, 'app');
    const { extractAll, createPackage } = require('@electron/asar');
    extractAll(join(resources, 'app.asar'), shell);
    await rm(join(resources, 'app.asar'));
    await cp(join(__dirname, 'desktop-harness.cjs'), join(shell, 'desktop-harness.cjs'));
    const manifest = JSON.parse(await readFile(join(shell, 'package.json'), 'utf8'));
    manifest.main = 'desktop-harness.cjs';
    await writeFile(join(shell, 'package.json'), JSON.stringify(manifest));
    await createPackage(shell, join(resources, 'app.asar'));
    await rm(shell, { recursive: true });
    executablePath = join(copy, 'Contents', 'MacOS', 'TravelDataBase');
    env.TDB_DESKTOP_QA_ENTRY = join(resources, 'app.asar', 'main.cjs');
    args = [];
    evidence.packaging = { source, testedCopy: copy, instrumentation: 'Copied bundle entrypoint wraps unchanged shell; production bundle is untouched; signing is not accepted by this test.' };
  }
  let electron;
  let page;
  let workerPid;
  let logs = '';
  try {
    electron = await _electron.launch({ executablePath, args, env, timeout: 90_000 });
    electron.process().stdout.on('data', (bytes) => { logs = (logs + bytes).slice(-20_000); });
    electron.process().stderr.on('data', (bytes) => { logs = (logs + bytes).slice(-20_000); });
    page = await electron.firstWindow({ timeout: 70_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.locator('body').waitFor();
    await page.waitForFunction(() => !!window.travelDesktop);
    const origin = new URL(page.url()).origin;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    evidence.launch = await electron.evaluate(({ app, BrowserWindow }) => {
      const state = globalThis.__desktopAcceptance;
      const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { runtime: state.runtime, workers: state.workers, userData: app.getPath('userData'), packaged: app.isPackaged, visible: BrowserWindow.getAllWindows()[0].isVisible(), devToolsOpened: BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened(),
        preferences: Object.fromEntries(['nodeIntegration', 'contextIsolation', 'sandbox', 'webSecurity', 'webviewTag'].map((key) => [key, preferences[key]])),
        startupErrors: state.startupErrors };
    });
    workerPid = evidence.launch.workers[0].pid;
    evidence.buildId = (await readFile(join(evidence.launch.workers[0].root, '.next', 'BUILD_ID'), 'utf8')).trim();
    assert.ok(evidence.launch.userData.startsWith(root));
    assert.ok(evidence.launch.runtime?.nativeBindings.length >= 3);
    assert.deepEqual(evidence.launch.startupErrors, []);
    assert.equal(evidence.launch.visible, false);
    assert.equal(evidence.launch.devToolsOpened, false);
    assert.deepEqual(evidence.launch.preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false });
    evidence.checks.guard = {
      missingToken: await requestStatus(origin),
      wrongToken: await electron.evaluate(async (_electron, url) => globalThis.__desktopAcceptance.requestStatus(url, { 'x-tdb-desktop-token': '0'.repeat(64) }), origin),
      wrongOrigin: await electron.evaluate(async (_electron, url) => globalThis.__desktopAcceptance.requestStatus(url, { Origin: 'https://invalid.example' }), origin),
      wrongHost: await electron.evaluate(async (_electron, url) => globalThis.__desktopAcceptance.requestStatus(url, { Host: 'localhost:1' }), origin),
      authorized: await electron.evaluate(async (_electron, url) => globalThis.__desktopAcceptance.requestStatus(url), origin),
    };
    for (const key of ['missingToken', 'wrongToken', 'wrongOrigin', 'wrongHost']) assert.equal(evidence.checks.guard[key], 403);
    assert.ok(evidence.checks.guard.authorized >= 200 && evidence.checks.guard.authorized < 400);
    evidence.checks.renderer = await page.evaluate(() => ({ nodeRequire: typeof require, nodeProcess: typeof process, keys: Object.keys(window.travelDesktop).sort(), text: document.body.innerText.slice(0, 1000) }));
    assert.equal(evidence.checks.renderer.nodeRequire, 'undefined');
    assert.equal(evidence.checks.renderer.nodeProcess, 'undefined');
    assert.deepEqual(evidence.checks.renderer.keys, ['beginSave', 'cancelSave', 'finishSave', 'readFileChunk', 'releaseFiles', 'selectFiles', 'version', 'writeSaveChunk'].sort());
    await page.screenshot({ path: join(screenshots, 'desktop-launch.png'), fullPage: true });
    await page.evaluate(() => window.open('about:blank'));
    await pause(100);
    assert.equal(electron.windows().length, 1);
    evidence.checks.windowOpenBlocked = true;
    const control = await electron.evaluate(async () => globalThis.__desktopAcceptance.testControlNetwork());
    assert.equal(control.failed, false);
    assert.equal(control.records.length, 1);
    assert.equal(control.records[0].method, 'POST');
    assert.equal(control.records[0].path, '/api/auth/logout');
    assert.equal(control.records[0].tokenMatched, true);
    assert.equal(control.records[0].privateCookieMatched, true);
    assert.equal(control.navigations[0], `${control.records[0].origin}/login`);
    assert.equal(control.remainingCookies, 0);
    assert.equal(control.unlockListeners, 0); assert.equal(control.resumeListeners, 0);
    evidence.checks.lockControlNetwork = { ...control, scope: 'Real Electron Session.fetch with a synthetic local logout endpoint and simulated OS event emitter; actual OS suspend/vault closure is not accepted by this fixture.' };

    const source = join(fixtures, 'Таблица для транспорта.xlsx');
    const sourceBytes = Buffer.alloc(256 * 1024 + 123);
    for (let index = 0; index < sourceBytes.length; index++) sourceBytes[index] = index % 251;
    await writeFile(source, sourceBytes);
    const native = false;
    await electron.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async (_window, options) => {
        globalThis.__desktopAcceptance.dialogs.push({ type: 'open', options });
        return { canceled: false, filePaths: [selected] };
      };
    }, source);
    const read = await page.evaluate(async () => {
      const api = window.travelDesktop;
      const files = await api.selectFiles({ kind: 'tables' });
      if (!files) throw new Error('Native open dialog canceled');
      const file = files[0];
      const bytes = new Uint8Array(file.size);
      let offset = 0; let chunks = 0;
      while (offset < file.size) {
        const chunk = await api.readFileChunk(file.id, offset);
        bytes.set(chunk, offset); offset += chunk.length; chunks++;
      }
      await api.releaseFiles(files.map((entry) => entry.id));
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return { metadata: file, chunks, digest: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') };
    });
    assert.equal(read.digest, digest(sourceBytes)); assert.equal(read.chunks, 2);
    assert.equal(read.metadata.name.normalize('NFC'), basename(source));
    assert.equal('path' in read.metadata, false);
    evidence.checks.openTransport = { chunks: read.chunks, digest: read.digest, nativeDialog: native, note: 'Synthetic binary tests transport; XLSX content parsing is outside this scenario.' };

    const target = join(fixtures, 'Отчёт с пробелами.pdf');
    await electron.evaluate(({ dialog }, selected) => {
      dialog.showSaveDialog = async (_window, options) => {
        globalThis.__desktopAcceptance.dialogs.push({ type: 'save', options });
        return { canceled: false, filePath: selected };
      };
    }, target);
    const saveBytes = Buffer.alloc(256 * 1024 + 89, 37);
    const saved = await page.evaluate(async ({ name, size }) => {
      const api = window.travelDesktop;
      const transfer = await api.beginSave(name, size);
      for (let offset = 0; offset < size;) {
        const chunk = new Uint8Array(Math.min(transfer.chunkBytes, size - offset)).fill(37);
        offset = await api.writeSaveChunk(transfer.id, offset, chunk);
      }
      return api.finishSave(transfer.id);
    }, { name: basename(target), size: saveBytes.length });
    assert.equal(saved, true); assert.equal(digest(await readFile(target)), digest(saveBytes));
    evidence.checks.saveTransport = { digest: digest(saveBytes), nativeDialog: native };
    // All remaining dialogs use explicit test responses. The production shell has no switches for this.
    await electron.evaluate(({ dialog }, selected) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected });
    }, target);
    await page.evaluate(async () => {
      const api = window.travelDesktop;
      const transfer = await api.beginSave('Отчёт с пробелами.pdf', 3);
      await api.writeSaveChunk(transfer.id, 0, new Uint8Array([1, 2, 3]));
      await api.finishSave(transfer.id);
    });
    assert.deepEqual(await readFile(target), Buffer.from([1, 2, 3]));
    evidence.checks.overwrite = true;
    await electron.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      dialog.showSaveDialog = async () => ({ canceled: true });
    });
    assert.deepEqual(await page.evaluate(async () => [await window.travelDesktop.selectFiles({ kind: 'sync' }), await window.travelDesktop.beginSave('x.pdf', 1)]), [null, null]);
    evidence.checks.dialogCancel = true;
    await electron.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }); }, target);
    const cancelId = await page.evaluate(async () => {
      const api = window.travelDesktop;
      const transfer = await api.beginSave('Отчёт с пробелами.pdf', 3);
      await api.writeSaveChunk(transfer.id, 0, new Uint8Array([9]));
      await api.cancelSave(transfer.id);
      return transfer.id;
    });
    await assert.rejects(page.evaluate((id) => window.travelDesktop.finishSave(id), cancelId));
    assert.deepEqual(await readFile(target), Buffer.from([1, 2, 3]));
    assert.equal((await readdir(fixtures)).some((name) => name.endsWith('.tmp')), false);
    evidence.checks.cancelCleanup = true;
    const backup = join(fixtures, 'Резервная копия.tdbbackup');
    await electron.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }); }, backup);
    assert.equal(await page.evaluate(async () => {
      const api = window.travelDesktop;
      const transfer = await api.beginSave('Резервная копия.tdbbackup', 3);
      await api.writeSaveChunk(transfer.id, 0, new Uint8Array([4, 5, 6]));
      return api.finishSave(transfer.id);
    }), true);
    assert.deepEqual(await readFile(backup), Buffer.from([4, 5, 6]));
    evidence.checks.backupSaveTransport = true;
    await electron.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, backup);
    await assert.rejects(page.evaluate(() => window.travelDesktop.selectFiles({ kind: 'sync' })));
    evidence.checks.backupRefusedBySyncChooser = true;
    await electron.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }); }, target);
    await page.evaluate(async () => {
      const api = window.travelDesktop;
      const transfer = await api.beginSave('Отчёт с пробелами.pdf', 3);
      await api.writeSaveChunk(transfer.id, 0, new Uint8Array([9]));
    });
    assert.equal((await readdir(fixtures)).some((name) => name.endsWith('.tmp')), true);
    const appLock = await electron.evaluate(async ({ powerMonitor, BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const ses = contents.session;
      const fetch = ses.fetch.bind(ses);
      const requests = [];
      ses.fetch = async (url, options) => {
        const response = await fetch(url, options);
        requests.push({ path: new URL(url).pathname, method: options.method, origin: options.headers.Origin,
          tokenMatched: options.headers['x-tdb-desktop-token'] === globalThis.__desktopAcceptance.token,
          credentials: options.credentials, status: response.status });
        return response;
      };
      try {
        const loaded = new Promise((done) => contents.once('did-finish-load', done));
        powerMonitor.emit('lock-screen');
        await Promise.race([loaded, new Promise((_done, reject) => setTimeout(() => reject(new Error('Application lock navigation timed out')), 10_000))]);
        const url = contents.getURL();
        powerMonitor.emit('unlock-screen'); powerMonitor.emit('resume');
        await new Promise((done) => setTimeout(done, 100));
        return { requests, url, afterUnlockUrl: contents.getURL() };
      } finally { ses.fetch = fetch; }
    });
    assert.equal(appLock.requests.length, 1);
    assert.equal(appLock.requests[0].path, '/api/auth/logout');
    assert.equal(appLock.requests[0].status, 200);
    assert.equal(appLock.requests[0].origin, origin);
    assert.equal(appLock.requests[0].tokenMatched, true);
    assert.equal(appLock.requests[0].credentials, 'include');
    assert.equal(appLock.afterUnlockUrl, appLock.url);
    assert.deepEqual(await readFile(target), Buffer.from([1, 2, 3]));
    assert.equal((await readdir(fixtures)).some((name) => name.endsWith('.tmp')), false);
    evidence.checks.appLock = { ...appLock, scope: 'Simulated lock-screen signal through actual main handler, actual Next logout endpoint on a fresh synthetic installation, navigation and file revocation; unlocked-vault key clearing and physical OS sleep remain unverified.' };
    await page.evaluate(async () => {
      const api = window.travelDesktop;
      const transfer = await api.beginSave('Отчёт с пробелами.pdf', 3);
      await api.writeSaveChunk(transfer.id, 0, new Uint8Array([9]));
    });
    // Playwright's electron.close uses app.quit and waits for the process to exit.
    await electron.close(); electron = null;
    assert.deepEqual(await readFile(target), Buffer.from([1, 2, 3]));
    assert.equal((await readdir(fixtures)).some((name) => name.endsWith('.tmp')), false);
    assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
    assert.match(logs, /DESKTOP_WORKER_EXIT=.*"code":0/);
    await assert.rejects(requestStatus(origin));
    evidence.checks.shutdown = { temporarySaveRemoved: true, originalPreserved: true, workerExitedCode: 0, portClosed: true };
    evidence.status = 'passed';
    console.log(`DESKTOP_ACCEPTANCE_PASSED=${root}`);
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error.stack || error);
    if (page) await page.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true }).catch(() => {});
    if (electron) evidence.failureState = await electron.evaluate(() => ({ errors: globalThis.__desktopAcceptance?.startupErrors, runtime: globalThis.__desktopAcceptance?.runtime })).catch(() => null);
    throw error;
  } finally {
    if (electron) await electron.close().catch(() => {});
    if (copiedBundle) {
      await rm(copiedBundle, { recursive: true, force: true });
      evidence.packaging.testedCopyRemoved = true;
    }
    evidence.finishedAt = new Date().toISOString();
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await writeFile(join(root, 'electron.log'), logs);
    console.log(`DESKTOP_QA_ARTIFACTS=${root}`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
