import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import type { TravelDesktopBridge } from '../types/desktop';
import { openLocalFiles, saveLocalFile } from '../lib/desktop-files';
const require = createRequire(import.meta.url);
const { LIMITS } = require('../desktop/validation.cjs');
const key = 'a'.repeat(64);

async function withBridge(api: Partial<TravelDesktopBridge>, run: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { travelDesktop: { version: 1, ...api } } });
  try { await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('renderer selection reconstructs real Files with bounded sequential reads and releases capabilities', async () => {
  const bytes = new Uint8Array(LIMITS.chunkBytes + 17).fill(42);
  const offsets: number[] = [];
  const released: string[][] = [];
  await withBridge({
    selectFiles: async () => [{ id: key, name: 'Таблица.docx', size: bytes.length, mimeType: 'application/test', lastModified: 123 }],
    readFileChunk: async (_id, offset) => { offsets.push(offset); return bytes.slice(offset, offset + LIMITS.chunkBytes); },
    releaseFiles: async (ids) => { released.push(ids); },
  }, async () => {
    const result = await openLocalFiles('tables');
    assert.equal(result?.[0] instanceof File, true);
    assert.equal(result?.[0].name, 'Таблица.docx');
    assert.equal(result?.[0].lastModified, 123);
    assert.deepEqual(new Uint8Array(await result![0].arrayBuffer()), bytes);
    assert.deepEqual(offsets, [0, LIMITS.chunkBytes]);
    assert.deepEqual(released, [[key]]);
  });
});

test('renderer saves bounded chunks with backpressure, commits once, and reports native cancellation', async () => {
  const blob = new Blob([new Uint8Array(LIMITS.chunkBytes * 2 + 7)]);
  const offsets: number[] = [];
  let inFlight = false;
  let commits = 0;
  await withBridge({
    beginSave: async () => ({ id: key, chunkBytes: LIMITS.chunkBytes }),
    writeSaveChunk: async (_id, offset, bytes) => {
      assert.equal(inFlight, false); inFlight = true;
      assert.ok(bytes.byteLength <= LIMITS.chunkBytes);
      assert.ok(bytes.buffer.byteLength <= LIMITS.chunkBytes);
      offsets.push(offset);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight = false;
      return offset + bytes.length;
    },
    finishSave: async () => { commits++; return true; },
  }, async () => {
    assert.equal(await saveLocalFile(blob, 'report.xlsx'), true);
    assert.deepEqual(offsets, [0, LIMITS.chunkBytes, LIMITS.chunkBytes * 2]);
    assert.equal(commits, 1);
  });
  await withBridge({ beginSave: async () => null, selectFiles: async () => null }, async () => {
    assert.equal(await saveLocalFile(blob, 'report.xlsx'), false);
    assert.equal(await openLocalFiles('sync'), null);
  });
});

test('renderer abort and transfer failure call native cleanup without committing', async () => {
  const abort = new AbortController();
  let cancelled = 0;
  let committed = 0;
  await withBridge({
    beginSave: async () => ({ id: key, chunkBytes: LIMITS.chunkBytes }),
    writeSaveChunk: async (_id, offset, bytes) => { abort.abort(); return offset + bytes.length; },
    cancelSave: async () => { cancelled++; },
    finishSave: async () => { committed++; return true; },
  }, async () => {
    assert.equal(await saveLocalFile(new Blob([new Uint8Array(LIMITS.chunkBytes + 1)]), 'x.pdf', { signal: abort.signal }), false);
    assert.equal(cancelled, 1); assert.equal(committed, 0);
  });
  await withBridge({
    beginSave: async () => ({ id: key, chunkBytes: LIMITS.chunkBytes }),
    writeSaveChunk: async () => { throw new Error('disk full'); },
    cancelSave: async () => { cancelled++; },
  }, async () => {
    await assert.rejects(saveLocalFile(new Blob(['content']), 'x.zip'), /disk full/);
    assert.equal(cancelled, 2);
  });
});

test('broken desktop never falls back to browser and failed reads release all handles', async () => {
  let released = 0;
  await withBridge({
    selectFiles: async () => [{ id: key, name: 'x.xlsx', size: 100, mimeType: 'x', lastModified: 0 }],
    readFileChunk: async () => new Uint8Array(),
    releaseFiles: async () => { released++; },
  }, async () => {
    await assert.rejects(openLocalFiles('tables'), /Повреждённая/);
    assert.equal(released, 1);
  });
  await withBridge({ beginSave: async () => { throw new Error('native dialog failed'); } }, async () => {
    await assert.rejects(saveLocalFile(new Blob(['x']), 'x.pdf'), /native dialog failed/);
  });
});

test('native cleanup failure stays visible when the renderer cancels an export', async () => {
  const controller = new AbortController();
  await withBridge({
    beginSave: async () => { controller.abort(); return { id: key, chunkBytes: LIMITS.chunkBytes }; },
    cancelSave: async () => { throw new Error('cleanup failed'); },
  }, async () => {
    await assert.rejects(saveLocalFile(new Blob(['x']), 'x.pdf', { signal: controller.signal }), /cleanup failed/);
  });
});

test('sandboxed preload exposes only file capabilities and rejects oversized messages before IPC', async () => {
  const source = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  let exposed: any;
  const calls: { channel: string; payload: unknown }[] = [];
  runInNewContext(source, {
    require: (name: string) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { assert.equal(name, 'travelDesktop'); exposed = api; } },
        ipcRenderer: { invoke: async (channel: string, payload: unknown) => { calls.push({ channel, payload }); } },
      };
    }, Uint8Array, ArrayBuffer,
  });
  assert.deepEqual(Object.keys(exposed).sort(), ['beginSave', 'cancelSave', 'finishSave', 'readFileChunk', 'releaseFiles', 'selectFiles', 'version', 'writeSaveChunk']);
  assert.equal(Object.isFrozen(exposed), true);
  assert.throws(() => exposed.writeSaveChunk(key, 0, new Uint8Array(LIMITS.chunkBytes + 1)));
  assert.equal(calls.length, 0);
  await exposed.selectFiles({ kind: 'tables', path: '/arbitrary/path' });
  assert.equal(JSON.stringify(calls[0].payload), '{"kind":"tables"}');
  // Validate metadata at the real boundary without allocating a gigabyte.
  const gigabyte = 1024 * 1024 * 1024;
  await exposed.beginSave('archive.tdbbackup', gigabyte);
  await exposed.readFileChunk(key, gigabyte);
  assert.throws(() => exposed.beginSave('archive.tdbbackup', gigabyte + 1));
  assert.throws(() => exposed.readFileChunk(key, gigabyte + 1));
});
