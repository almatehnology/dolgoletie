'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, mkdir, writeFile, access, readFile, lstat, symlink, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { prepare } = require('./prepare.cjs');
const { verifyPackage } = require('./verify-package.cjs');
const { systemEnvironment, runtimeEnvironment } = require('./runtime.cjs');
const { validateSave, validateSelectedFile, MIME, LIMITS } = require('./validation.cjs');

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'tdb-portability-'));
  try { await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function put(root, relative, value = 'synthetic packaging fixture') {
  const file = join(root, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, value);
}

const protectedFiles = [
  'prisma/data/untouched.txt', 'nested/Prisma/Data/untouched.txt',
  'nested/legacy.db', 'nested/legacy.DB-wal', 'nested/legacy.db-shm', 'nested/legacy.db-journal',
  'nested/legacy.sqlite', 'nested/legacy.sqlite3-wal',
  'node_modules/fixture/.ENV.local', 'assets/.env.production',
  'nested/auth.json', 'nested/auth.json.lock', 'nested/vault.json', 'nested/instance.json',
  'nested/credential-transition.json', 'nested/storage-transition.json',
  'nested/pending-access/token.json', 'nested/vaults/generation/scan.png',
  'assets/export.zip', 'assets/export.tdbsync', 'assets/export.tdbbackup',
];

test('prepare excludes protected artifacts recursively while retaining compiled data routes and runtime assets', async () => fixture(async (root) => {
  const project = join(root, 'Проект с пробелами');
  const source = join(project, '.next', 'standalone');
  await put(project, 'package.json', JSON.stringify({ version: '0.1.0' }));
  await put(project, '.next/static/chunk.js');
  await put(project, '.next/static/.ENV.local');
  await put(project, 'public/.ENV');
  await put(project, 'assets/export.tdbbackup');
  await put(project, 'assets/font.ttf');
  await put(project, 'prisma/migrations/fixture/migration.sql');
  await put(project, 'prisma/migrations/fixture/accidental.db');
  await put(source, 'server.js');
  await put(source, '.next/server/app/(app)/data/page.js', 'compiled data route');
  await put(source, 'node_modules/fixture/prebuilds/win32-x64.node');
  for (const file of protectedFiles) await put(source, file);
  const { destination } = await prepare(project, join(root, 'stage'));
  for (const file of [...protectedFiles, '.next/static/.ENV.local', 'public/.ENV', 'prisma/migrations/fixture/accidental.db']) {
    await assert.rejects(access(join(destination, file)), { code: 'ENOENT' }, file);
  }
  assert.equal(await readFile(join(destination, '.next/server/app/(app)/data/page.js'), 'utf8'), 'compiled data route');
  for (const file of ['.next/static/chunk.js', 'assets/font.ttf', 'prisma/migrations/fixture/migration.sql', 'node_modules/fixture/prebuilds/win32-x64.node']) {
    await access(join(destination, file));
  }
}));

test('prepare materializes internal directory links and refuses resource links outside their source', async () => fixture(async (root) => {
  const project = join(root, 'project');
  const source = join(project, '.next', 'standalone');
  await put(project, 'package.json', JSON.stringify({ version: '0.1.0' }));
  await put(project, '.next/static/chunk.js');
  await put(source, 'server.js');
  await put(source, 'node_modules/fixture/index.js');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(join(source, 'node_modules/fixture'), join(source, 'internal-link'), type);
  const target = join(root, 'stage');
  const { destination } = await prepare(project, target);
  assert.equal((await lstat(join(destination, 'internal-link'))).isSymbolicLink(), false);
  await access(join(destination, 'internal-link/index.js'));
  await put(root, 'outside/index.js');
  await symlink(join(root, 'outside'), join(source, 'outside-link'), type);
  await assert.rejects(prepare(project, target), /outside its source directory/u);
}));

async function fakePackage(resources) {
  const root = join(resources, 'next');
  await put(root, 'server.js');
  await put(root, '.next/BUILD_ID', 'synthetic-build');
  await put(root, '.next/static/chunk.js');
  for (const name of ['next', 'better-sqlite3-multiple-ciphers', 'argon2', 'sharp', '@prisma/client']) {
    await put(root, `node_modules/${name}/index.js`);
  }
  await put(root, 'node_modules/.prisma/client/default.js');
  return root;
}

test('afterPack independently rejects nested data, metadata, transfers and environment files without reading their contents', async () => fixture(async (root) => {
  const resources = join(root, 'resources');
  const runtime = await fakePackage(resources);
  assert.equal((await verifyPackage(resources)).buildId, 'synthetic-build');
  for (const file of protectedFiles) {
    await put(runtime, file);
    await assert.rejects(verifyPackage(resources), /protected data artifact|environment file/u, file);
    // Remove only this test's generated branch, never an actual standalone tree.
    await rm(join(runtime, file.split('/')[0]), { recursive: true, force: true });
    // Some fixtures live under node_modules, so restore its synthetic modules.
    await fakePackage(resources);
  }
  await put(runtime, '.next/server/app/(app)/data/page.js');
  assert.equal((await verifyPackage(resources)).buildId, 'synthetic-build');
}));

test('image saves allow exactly the native 64 MiB ceiling, portable names and declared MIME types', () => {
  for (const [ext, mime] of Object.entries({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })) {
    assert.equal(MIME[`.${ext}`], mime);
    assert.doesNotThrow(() => validateSave({ filename: `Скан с пробелами.${ext.toUpperCase()}`, size: 64 * 1024 * 1024 }));
    assert.throws(() => validateSave({ filename: `scan.${ext}`, size: 64 * 1024 * 1024 + 1 }));
    assert.throws(() => validateSelectedFile('tables', `scan.${ext}`, 1));
    assert.throws(() => validateSelectedFile('sync', `scan.${ext}`, 1));
  }
  assert.equal(LIMITS.reportBytes, 64 * 1024 * 1024);
  for (const filename of ['CON .pdf', 'COM1 .jpg', 'CONIN$.pdf', 'CONOUT$.png', 'LPT² .webp', 'scan.png:stream', '../scan.png', 'scan.gif']) {
    assert.throws(() => validateSave({ filename, size: 1 }), filename);
  }
});

test('Windows system environment uses canonical keys and does not forward runtime injection variables', () => {
  assert.deepEqual(systemEnvironment({
    systemroot: 'C:\\Windows', WINDIR: 'C:\\Windows', TeMp: 'C:\\Temp', userprofile: 'C:\\Users\\fixture',
    NODE_OPTIONS: '--require=not-allowed', nOdE_pAtH: 'not-allowed', Path: 'not-allowed', APP_PASSWORD: 'not-allowed',
  }, 'win32'), { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: 'C:\\Temp', USERPROFILE: 'C:\\Users\\fixture' });
  assert.deepEqual(systemEnvironment({ temp: '/ignored', TEMP: '/fixture', node_options: 'not-allowed' }, 'darwin'), { TEMP: '/fixture' });
});

test('runtime paths use file URLs and only the storage variables consumed by the application', async () => fixture(async (root) => {
  const userData = join(root, 'Данные с пробелами');
  const env = await runtimeEnvironment(userData, 'a'.repeat(64), { VAULT_PATH: 'ignored', VaultPath: 'ignored' });
  assert.equal(env.DATA_DIR, join(userData, 'data'));
  assert.equal(env.DATABASE_URL, pathToFileURL(join(userData, 'data', 'data.db')).href);
  assert.equal(env.AUTH_FILE, join(userData, 'data', 'auth.json'));
  assert.equal(env.UPLOADS_DIR, join(userData, 'uploads'));
  assert.equal(env.VAULT_PATH, undefined);
  assert.equal(env.VaultPath, undefined);
}));
