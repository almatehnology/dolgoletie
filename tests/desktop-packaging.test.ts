import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { prepare } = require('../desktop/prepare.cjs');
const config = require('../desktop/electron-builder.cjs');

for (const nested of [false, true]) test(`packaging excludes secrets/user data and keeps native payloads (${nested ? 'workspace' : 'root'} standalone)`, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tdb-desktop-packaging-'));
  const project = join(folder, 'TravelDataBase');
  const standalone = join(project, '.next', 'standalone', ...(nested ? ['TravelDataBase'] : []));
  const stage = join(folder, 'stage');
  try {
    for (const path of [standalone, join(project, '.next', 'static'), join(standalone, 'data'), join(standalone, 'uploads'), join(standalone, 'node_modules', 'native', 'prebuilds'), join(project, 'assets'), join(project, 'prisma', 'migrations')]) await mkdir(path, { recursive: true });
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'web-app', version: '0.2.3', dependencies: { electron: '*', next: '*', argon2: '*' } }));
    await writeFile(join(standalone, 'server.js'), 'server');
    await writeFile(join(standalone, '.env'), 'SECRET=private');
    await writeFile(join(standalone, 'node_modules', 'native', '.env.local'), 'SECRET=private');
    await writeFile(join(standalone, 'node_modules', 'native', 'prebuilds', 'darwin-arm64.node'), 'native fixture');
    await writeFile(join(standalone, 'data', 'data.db'), 'private data');
    await writeFile(join(standalone, 'uploads', 'scan.png'), 'private scan');
    await writeFile(join(project, '.next', 'static', 'script.js'), 'static');
    await writeFile(join(project, 'assets', 'font.ttf'), 'font');
    const output = await prepare(project, stage);
    assert.equal(output.source, standalone);
    const contents = await readdir(join(stage, 'next'));
    for (const name of ['.env', 'data', 'uploads']) assert.equal(contents.includes(name), false);
    assert.deepEqual(await readdir(join(stage, 'next', 'node_modules', 'native')), ['prebuilds']);
    assert.equal(await readFile(join(stage, 'next', 'node_modules', 'native', 'prebuilds', 'darwin-arm64.node'), 'utf8'), 'native fixture');
    assert.equal(await readFile(join(stage, 'next', '.next', 'static', 'script.js'), 'utf8'), 'static');
    const shell = JSON.parse(await readFile(join(stage, 'app', 'package.json'), 'utf8'));
    assert.equal(shell.version, '0.2.3');
    assert.deepEqual(shell.dependencies, {});
    assert.equal(shell.main, 'main.cjs');
    assert.equal((await readdir(join(stage, 'app'))).includes('desktop-harness.cjs'), false);
    assert.equal(await readFile(join(stage, 'app', config.extraMetadata.main), 'utf8'), await readFile(require.resolve('../desktop/main.cjs'), 'utf8'));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a missing standalone build preserves the previous prepared stage', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tdb-desktop-packaging-'));
  try {
    const stage = join(folder, 'stage');
    await mkdir(join(stage, 'next'), { recursive: true });
    await writeFile(join(stage, 'next', 'server.js'), 'last working build');
    await assert.rejects(prepare(join(folder, 'missing'), stage));
    assert.equal(await readFile(join(stage, 'next', 'server.js'), 'utf8'), 'last working build');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('platform packaging uses the minimal shell, separate server resources and preserves Windows user data', () => {
  assert.equal(config.directories.app, 'desktop/stage/app');
  assert.equal(config.asar, true);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.extraResources[0].to, 'next');
  assert.equal(config.extraResources[1].from, 'desktop/stage/next/node_modules');
  assert.equal(config.extraResources[1].to, 'next/node_modules');
  assert.equal(config.mac.hardenedRuntime, true);
  assert.deepEqual(config.win.target, ['nsis']);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});
