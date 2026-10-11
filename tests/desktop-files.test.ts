import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, writeFile, readdir, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { FileBroker } = require('../desktop/files.cjs');
const { LIMITS } = require('../desktop/validation.cjs');
const trusted = () => {};

async function fixture(run: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'tdb-desktop-'));
  try { await run(folder); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

test('multiple office files are read in bounded sequential chunks without exposing paths', async () => fixture(async (folder) => {
  const first = join(folder, 'Таблица.xlsx');
  const second = join(folder, 'Таблица.docx');
  const bytes = Buffer.alloc(LIMITS.chunkBytes + 123, 42);
  await writeFile(first, bytes); await writeFile(second, 'doc');
  const broker = new FileBroker({ selectDialog: async () => [first, second] });
  const files = await broker.select({ kind: 'tables' }, trusted);
  assert.equal(files.length, 2);
  assert.deepEqual(Object.keys(files[0]).sort(), ['id', 'lastModified', 'mimeType', 'name', 'size']);
  await assert.rejects(broker.read({ id: files[0].id, offset: 1 }, trusted));
  const chunk = await broker.read({ id: files[0].id, offset: 0 }, trusted);
  assert.equal(chunk.byteLength, LIMITS.chunkBytes);
  const rest = await broker.read({ id: files[0].id, offset: chunk.byteLength }, trusted);
  assert.deepEqual(Buffer.concat([chunk, rest]), bytes);
  await assert.rejects(broker.read({ id: files[0].id, offset: bytes.length }, trusted));
  await broker.release({ ids: files.map((file: { id: string }) => file.id) }, trusted);
  assert.equal(broker.reads.size, 0);
}));

test('dialog cancellation has no filesystem side effects', async () => fixture(async (folder) => {
  const broker = new FileBroker({ selectDialog: async () => null, saveDialog: async () => null });
  assert.equal(await broker.select({ kind: 'sync' }, trusted), null);
  assert.equal(await broker.beginSave({ filename: 'отчёт.pdf', size: 5 }, trusted), null);
  assert.deepEqual(await readdir(folder), []);
}));

test('save commits only exact complete content through an atomic same-directory rename', async () => fixture(async (folder) => {
  const target = join(folder, 'Отчёт.pdf');
  await writeFile(target, 'old report');
  const broker = new FileBroker({ saveDialog: async () => target });
  const transfer = await broker.beginSave({ filename: 'Отчёт.pdf', size: 7 }, trusted);
  await broker.write({ id: transfer.id, offset: 0, bytes: new Uint8Array(Buffer.from('new pdf')) }, trusted);
  assert.equal(await readFile(target, 'utf8'), 'old report');
  assert.equal((await readdir(folder)).length, 2);
  assert.equal(await broker.commit({ id: transfer.id }, trusted), true);
  assert.equal(await readFile(target, 'utf8'), 'new pdf');
  assert.deepEqual(await readdir(folder), ['Отчёт.pdf']);
}));

test('truncated saves, overflow and repeated offsets preserve original and remove temporary files', async () => fixture(async (folder) => {
  const target = join(folder, 'report.pdf');
  await writeFile(target, 'original');
  for (const failure of ['incomplete', 'overflow', 'offset']) {
    const broker = new FileBroker({ saveDialog: async () => target });
    const transfer = await broker.beginSave({ filename: 'report.pdf', size: 4 }, trusted);
    if (failure === 'incomplete') {
      await broker.write({ id: transfer.id, offset: 0, bytes: new Uint8Array([1]) }, trusted);
      await assert.rejects(broker.commit({ id: transfer.id }, trusted));
    } else {
      await assert.rejects(broker.write({ id: transfer.id, offset: failure === 'offset' ? 1 : 0, bytes: new Uint8Array(failure === 'overflow' ? 5 : 1) }, trusted));
    }
    assert.equal(await readFile(target, 'utf8'), 'original');
    assert.deepEqual(await readdir(folder), ['report.pdf']);
  }
}));

test('abort, expiry and navigation revoke all read and write capabilities', async () => fixture(async (folder) => {
  const target = join(folder, 'sync.zip');
  const source = join(folder, 'table.xlsx');
  await writeFile(source, 'data');
  let now = 0;
  const broker = new FileBroker({ saveDialog: async () => target, selectDialog: async () => [source], now: () => now });
  const transfer = await broker.beginSave({ filename: 'sync.zip', size: 4 }, trusted);
  await broker.write({ id: transfer.id, offset: 0, bytes: new Uint8Array([1]) }, trusted);
  await broker.abort({ id: transfer.id }, trusted);
  assert.deepEqual(await readdir(folder), ['table.xlsx']);
  const selected = await broker.select({ kind: 'tables' }, trusted);
  const expired = await broker.beginSave({ filename: 'sync.zip', size: 1 }, trusted);
  now = LIMITS.idleMs + 1;
  await assert.rejects(broker.write({ id: expired.id, offset: 0, bytes: new Uint8Array([1]) }, trusted));
  await assert.rejects(broker.read({ id: selected[0].id, offset: 0 }, trusted));
  const revoked = await broker.beginSave({ filename: 'sync.zip', size: 1 }, trusted);
  await broker.revoke();
  await assert.rejects(broker.commit({ id: revoked.id }, trusted));
  assert.deepEqual(await readdir(folder), ['table.xlsx']);
}));

test('a pending native dialog cannot grant capabilities after navigation or to concurrent calls', async () => fixture(async (folder) => {
  let resolveDialog!: (value: string) => void;
  const broker = new FileBroker({ saveDialog: () => new Promise((resolve) => { resolveDialog = resolve; }) });
  const pending = broker.beginSave({ filename: 'x.pdf', size: 1 }, trusted);
  const rejection = assert.rejects(pending, /отменена/);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(broker.beginSave({ filename: 'x.pdf', size: 1 }, trusted), /Дождитесь/);
  const revoked = broker.revoke();
  resolveDialog(join(folder, 'x.pdf'));
  await rejection; await revoked;
  assert.deepEqual(await readdir(folder), []);
}));

test('changed imports and changed destinations are refused without overwriting data', async () => fixture(async (folder) => {
  const source = join(folder, 'table.docx');
  const target = join(folder, 'x.pdf');
  await writeFile(source, '12345'); await writeFile(target, 'original');
  const broker = new FileBroker({ selectDialog: async () => [source], saveDialog: async () => target });
  const selected = await broker.select({ kind: 'tables' }, trusted);
  await truncate(source, 1);
  await assert.rejects(broker.read({ id: selected[0].id, offset: 0 }, trusted), /изменился/);
  const transfer = await broker.beginSave({ filename: 'x.pdf', size: 1 }, trusted);
  await broker.write({ id: transfer.id, offset: 0, bytes: new Uint8Array([1]) }, trusted);
  await writeFile(target, 'concurrent change');
  await assert.rejects(broker.commit({ id: transfer.id }, trusted), /назначения изменился/);
  assert.equal(await readFile(target, 'utf8'), 'concurrent change');
  assert.deepEqual((await readdir(folder)).sort(), ['table.docx', 'x.pdf']);
}));

test('dialog filters are independently enforced and symlink targets are refused', async () => fixture(async (folder) => {
  const source = join(folder, 'file.exe');
  const link = join(folder, 'link.docx');
  await writeFile(source, 'data');
  const broker = new FileBroker({ selectDialog: async () => [source], saveDialog: async () => join(folder, 'x.exe') });
  await assert.rejects(broker.select({ kind: 'tables' }, trusted), /расширение/);
  await assert.rejects(broker.beginSave({ filename: 'x.pdf', size: 1 }, trusted), /Расширение/);
  if (process.platform !== 'win32') {
    await symlink(source, link);
    const other = new FileBroker({ selectDialog: async () => [link], saveDialog: async () => link });
    await assert.rejects(other.select({ kind: 'tables' }, trusted), /обычный файл/);
  }
}));

test('aggregate limits reject sparse oversized selections and close all opened descriptors', async () => fixture(async (folder) => {
  const paths = Array.from({ length: 5 }, (_, index) => join(folder, `table-${index}.xlsx`));
  for (const path of paths) { await writeFile(path, ''); await truncate(path, LIMITS.tableFileBytes); }
  const broker = new FileBroker({ selectDialog: async () => paths });
  await assert.rejects(broker.select({ kind: 'tables' }, trusted), /общий лимит/);
  assert.equal(broker.reads.size, 0);
}));

test('a disk write failure cleans the partial export and never modifies its destination', async () => fixture(async (folder) => {
  const target = join(folder, 'report.pdf');
  await writeFile(target, 'original');
  const broker = new FileBroker({ saveDialog: async () => target });
  const transfer = await broker.beginSave({ filename: 'report.pdf', size: 4 }, trusted);
  const handle = broker.saves.get(transfer.id).handle;
  handle.write = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(broker.write({ id: transfer.id, offset: 0, bytes: new Uint8Array([1]) }, trusted), { code: 'ENOSPC' });
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.deepEqual(await readdir(folder), ['report.pdf']);
  assert.equal(broker.saves.size, 0);
}));

test('cleanup failure cannot reactivate an aborted save and can be retried', async () => fixture(async (folder) => {
  const target = join(folder, 'report.pdf');
  const broker = new FileBroker({ saveDialog: async () => target });
  const transfer = await broker.beginSave({ filename: 'report.pdf', size: 1 }, trusted);
  const record = broker.saves.get(transfer.id);
  // Substitute a directory at the temp name to model an unlink failure deterministically.
  await record.handle.close();
  await rm(record.temp);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(record.temp);
  await assert.rejects(broker.abort({ id: transfer.id }, trusted));
  assert.equal(record.aborted, true);
  await assert.rejects(broker.commit({ id: transfer.id }, trusted));
  await rm(record.temp, { recursive: true });
  await broker.revoke();
  assert.equal(broker.saves.size, 0);
  assert.deepEqual(await readdir(folder), []);
}));
