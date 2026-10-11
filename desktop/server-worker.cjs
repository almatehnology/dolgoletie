'use strict';

const { resolve, relative, isAbsolute } = require('node:path');
const { realpathSync } = require('node:fs');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { installServerBoundary } = require('./server-boundary.cjs');
const root = resolve(process.argv[2]);
const serverPath = resolve(root, 'server.js');
const send = (message) => process.parentPort?.postMessage(message);
let boundary;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await boundary?.close();
  process.exit(0);
}

process.parentPort?.on('message', (event) => {
  if (event.data?.type === 'shutdown') void stop();
});
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

async function start() {
  process.chdir(root);
  const runtimeRequire = createRequire(serverPath);
  const realRoot = realpathSync(root);
  const suppliedPath = (path) => {
    const inside = relative(realRoot, realpathSync(path));
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Standalone dependency resolved outside supplied resources');
    return inside;
  };
  const packages = {};
  // Fail before opening the user's DB. Never silently switch runtimes or run Prisma CLI.
  for (const name of ['better-sqlite3-multiple-ciphers', 'argon2', 'sharp', '@prisma/client']) {
    const path = runtimeRequire.resolve(name);
    packages[name] = suppliedPath(path);
  }
  const Database = runtimeRequire('better-sqlite3-multiple-ciphers');
  // This driver deliberately refuses encryption keys on :memory: databases.
  // Verify encrypted file reopen using a fresh OS temp directory, never user data.
  const temporary = await mkdtemp(join(tmpdir(), 'tdb-native-preflight-'));
  let db;
  try {
    const file = join(temporary, 'preflight.db');
    db = new Database(file);
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("key = 'desktop-runtime-preflight'");
    db.exec('CREATE TABLE preflight (value TEXT)');
    db.prepare('INSERT INTO preflight VALUES (?)').run('ready');
    db.close();
    if ((await readFile(file)).subarray(0, 16).toString() === 'SQLite format 3\0') throw new Error('SQLite preflight file was not encrypted');
    db = new Database(file);
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("key = 'desktop-runtime-preflight'");
    if (db.prepare('SELECT value FROM preflight').get().value !== 'ready') throw new Error('SQLite runtime preflight failed');
  } finally {
    if (db?.open) db.close();
    await rm(temporary, { recursive: true, force: true });
  }
  const argon2 = runtimeRequire('argon2');
  const hash = await argon2.hash('desktop-runtime-preflight', { memoryCost: 8192, timeCost: 1, parallelism: 1 });
  if (!await argon2.verify(hash, 'desktop-runtime-preflight')) throw new Error('Argon2 runtime preflight failed');
  const sharp = runtimeRequire('sharp');
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  if (typeof runtimeRequire('@prisma/client').PrismaClient !== 'function') throw new Error('Prisma client runtime preflight failed');
  const nativeBindings = Object.keys(require.cache).filter((path) => path.endsWith('.node')).map(suppliedPath);
  send({ type: 'runtime', node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi,
    platform: process.platform, arch: process.arch, packages, nativeBindings });

  boundary = installServerBoundary(process.env.DESKTOP_LAUNCH_TOKEN, (origin) => send({ type: 'listening', origin }));
  require(serverPath);
}

start().catch((error) => {
  send({ type: 'startup-error', message: String(error.message).slice(0, 2000) });
  process.exit(1);
});
