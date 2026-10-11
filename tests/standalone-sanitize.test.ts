import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { sanitizeStandalone } = require('../scripts/sanitize-standalone.cjs');

test('standalone distribution removes settings and database copies while keeping compiled data routes and source data', async () => {
  const project = await mkdtemp(join(tmpdir(), 'tdb-package-sanitize-'));
  try {
    const output = join(project, '.next', 'standalone');
    const route = join(output, '.next/server/app/(app)/data');
    await mkdir(route, { recursive: true });
    await mkdir(join(output, 'prisma/data'), { recursive: true });
    await mkdir(join(project, 'data'), { recursive: true });
    await writeFile(join(project, 'data/original.db'), 'source fixture');
    await writeFile(join(output, 'server.js'), 'synthetic entry');
    await writeFile(join(route, 'page.js'), 'compiled route fixture');
    await writeFile(join(output, '.env'), 'synthetic settings');
    await writeFile(join(output, 'prisma/data/copy.db'), 'copied database fixture');
    await writeFile(join(output, 'copy.sqlite3-wal'), 'copied journal fixture');
    assert.equal(sanitizeStandalone(project), 3);
    await assert.rejects(access(join(output, '.env')));
    await assert.rejects(access(join(output, 'prisma/data')));
    await assert.rejects(access(join(output, 'copy.sqlite3-wal')));
    assert.equal(await readFile(join(route, 'page.js'), 'utf8'), 'compiled route fixture');
    assert.equal(await readFile(join(project, 'data/original.db'), 'utf8'), 'source fixture');
    assert.equal(sanitizeStandalone(project), 0);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('standalone cleanup rejects paths outside the project and incomplete output', async () => {
  const project = await mkdtemp(join(tmpdir(), 'tdb-package-sanitize-'));
  try {
    assert.throws(() => sanitizeStandalone(project, '..'), /inside the project/);
    assert.throws(() => sanitizeStandalone(project), /missing/);
    await mkdir(join(project, '.next/standalone'), { recursive: true });
    assert.throws(() => sanitizeStandalone(project), /Invalid standalone/);
  } finally { await rm(project, { recursive: true, force: true }); }
});
