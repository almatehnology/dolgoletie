'use strict';

const { mkdir, access } = require('node:fs/promises');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const { validOrigin } = require('./validation.cjs');
const { TOKEN_HEADER } = require('./server-boundary.cjs');

function systemEnvironment(inherited, platform = process.platform) {
  const names = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL'];
  const env = {};
  if (platform === 'win32') {
    // Windows environment names are case insensitive. Pass one canonical spelling.
    const keys = new Map(Object.keys(inherited).map((key) => [key.toLowerCase(), key]));
    for (const name of names) {
      const key = keys.get(name.toLowerCase());
      if (key !== undefined) env[name] = inherited[key];
    }
  } else {
    for (const name of [...names, 'SYSTEMROOT']) {
      if (inherited[name] !== undefined) env[name] = inherited[name];
    }
  }
  return env;
}

async function runtimeEnvironment(userData, token, inherited = process.env) {
  const data = join(userData, 'data');
  const uploads = join(userData, 'uploads');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(uploads, { recursive: true, mode: 0o700 });
  // Do not inherit .env secrets, Node injection flags, DB paths or proxy configuration.
  const env = systemEnvironment(inherited);
  return Object.assign(env, {
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: '0',
    NEXT_TELEMETRY_DISABLED: '1',
    COOKIE_SECURE: 'false',
    SESSION_SECRET: randomBytes(48).toString('hex'),
    DATA_DIR: data,
    DATABASE_URL: pathToFileURL(join(data, 'data.db')).href,
    UPLOADS_DIR: uploads,
    AUTH_FILE: join(data, 'auth.json'),
    DESKTOP_MODE: '1',
    DESKTOP_LAUNCH_TOKEN: token,
  });
}

function probe(origin, token) {
  return new Promise((resolve) => {
    const request = http.get(`${origin}/`, { headers: { [TOKEN_HEADER]: token }, timeout: 2000 }, (response) => {
      const ok = response.statusCode >= 200 && response.statusCode < 400;
      response.destroy();
      resolve(ok);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function launchServer({ utilityProcess, userData, standalone, worker }) {
  await access(join(standalone, 'server.js'));
  const token = randomBytes(32).toString('hex');
  const env = await runtimeEnvironment(userData, token);
  const child = utilityProcess.fork(worker, [standalone], {
    env, cwd: standalone, stdio: 'pipe', serviceName: 'TravelDataBase local data',
  });
  // Consume bounded output without storing DB/HTTP errors and personal data on disk.
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  let origin;
  let error;
  let exited = false;
  let runtime;
  let intentionalExit = false;
  let onUnexpectedExit = () => {};
  child.on('message', (message) => {
    if (message?.type === 'listening' && validOrigin(message.origin)) origin = message.origin;
    if (message?.type === 'startup-error') error = new Error(String(message.message).slice(0, 2000));
    if (message?.type === 'runtime') runtime = {
      node: message.node, modules: message.modules, napi: message.napi,
      platform: message.platform, arch: message.arch, packages: message.packages, nativeBindings: message.nativeBindings,
    };
  });
  child.on('error', () => { error = new Error('Локальный процесс данных завершился с ошибкой'); });
  child.on('exit', () => {
    exited = true;
    if (!intentionalExit) onUnexpectedExit();
  });
  const stop = async () => {
    intentionalExit = true;
    if (exited) return;
    try { child.postMessage({ type: 'shutdown' }); }
    catch { /* The process can exit between the check and postMessage. */ }
    const deadline = Date.now() + 4000;
    while (!exited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!exited) {
      child.kill();
      const killDeadline = Date.now() + 500;
      while (!exited && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
      // SIGTERM cannot stop a utility process stuck in native code. Use only its owned PID.
      const pid = child.pid;
      if (!exited && Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
      }
      const finalDeadline = Date.now() + 1000;
      while (!exited && Date.now() < finalDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
      if (!exited) throw new Error('Локальный процесс данных не завершился');
    }
  };
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (error) throw error;
      if (exited) throw new Error('Локальный процесс данных не запустился');
      if (origin && await probe(origin, token)) {
        if (exited || error) throw error || new Error('Локальный процесс завершился');
        return { origin, token, runtime, stop, onExit: (handler) => { onUnexpectedExit = handler; if (exited) handler(); } };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Превышено время запуска локального процесса данных');
  } catch (failure) { await stop(); throw failure; }
}

module.exports = { runtimeEnvironment, launchServer, probe, systemEnvironment };
