import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const v = require('../desktop/validation.cjs');
const { trustedRequest, TOKEN_HEADER } = require('../desktop/server-boundary.cjs');
const origin = 'http://127.0.0.1:43127';
const token = 'a'.repeat(64);

test('IPC is restricted to the registered window main frame and exact launch origin', () => {
  const sender = { senderId: 7, expectedSenderId: 7, isMainFrame: true, frameUrl: `${origin}/people?q=1`, origin };
  assert.doesNotThrow(() => v.validateSender(sender));
  for (const patch of [
    { senderId: 8 }, { isMainFrame: false }, { frameUrl: 'about:blank' },
    { frameUrl: 'file:///etc/passwd' }, { frameUrl: 'https://example.com' },
    { frameUrl: 'http://localhost:43127/' }, { frameUrl: 'http://127.0.0.1:43128/' },
    { frameUrl: 'http://127.0.0.1:43127.evil.test/' },
    { frameUrl: 'http://user:pass@127.0.0.1:43127/' },
    { origin: 'http://0.0.0.0:43127' }, { origin: 'http://127.0.0.1:0' },
  ]) assert.throws(() => v.validateSender({ ...sender, ...patch }));
});

test('IPC cannot supply file paths, unrecognised options or save extensions', () => {
  assert.equal(v.validateSelect({ kind: 'tables' }), 'tables');
  assert.equal(v.validateSelect({ kind: 'sync' }), 'sync');
  for (const value of [null, [], {}, { kind: 'all' }, { kind: 'tables', path: '/tmp/x' }]) assert.throws(() => v.validateSelect(value));
  for (const filename of ['../x.pdf', '..\\x.pdf', '/tmp/x.pdf', 'C:x.pdf', 'x.pdf:stream', 'CON.pdf', 'nul.XLSX', 'LPT1.zip', 'a\0.pdf', 'a.pdf ', 'a.pdf.', 'x.exe', 'x.json', 'a'.repeat(181) + '.pdf', 'я'.repeat(100) + '.pdf']) {
    assert.throws(() => v.validateSave({ filename, size: 1 }), filename);
  }
  for (const filename of ['Отчёт участников.pdf', 'Экспорт.XLSX', 'обмен.zip', 'обмен.tdbsync', 'Резервная копия.tdbbackup']) {
    assert.doesNotThrow(() => v.validateSave({ filename, size: 1 }));
  }
  assert.throws(() => v.validateSave({ filename: 'x.pdf', size: 1, path: '/tmp/x.pdf' }));
});

test('file and aggregate count/size limits are finite and format-specific', () => {
  v.validateSelectedFile('tables', 'x.docx', v.LIMITS.tableFileBytes);
  v.validateSelectedFile('sync', 'x.zip', v.LIMITS.syncBytes);
  for (const size of [-1, NaN, Infinity, 1.5, v.LIMITS.tableFileBytes + 1]) assert.throws(() => v.validateSelectedFile('tables', 'x.xlsx', size));
  assert.throws(() => v.validateSelectedFile('tables', 'x.zip', 1));
  assert.throws(() => v.validateSelectedFile('sync', 'x.docx', 1));
  assert.throws(() => v.validateSelectionCount('sync', 2));
  assert.throws(() => v.validateSelectionCount('tables', 33));
  assert.throws(() => v.validateSelectionCount('tables', 0));
  assert.throws(() => v.validateSave({ filename: 'x.pdf', size: v.LIMITS.reportBytes + 1 }));
  assert.throws(() => v.validateSave({ filename: 'x.zip', size: v.LIMITS.syncBytes + 1 }));
  assert.doesNotThrow(() => v.validateSave({ filename: 'x.tdbbackup', size: v.LIMITS.syncBytes }));
  assert.throws(() => v.validateSave({ filename: 'x.tdbbackup', size: v.LIMITS.syncBytes + 1 }));
  assert.throws(() => v.validateSelectedFile('sync', 'x.tdbbackup', 1));
  assert.throws(() => v.validateSelectedFile('tables', 'x.tdbbackup', 1));
  assert.equal(v.MIME['.tdbbackup'], 'application/octet-stream');
});

test('chunks are bounded binary data with opaque ids and finite offsets', () => {
  const payload = { id: token, offset: 0, bytes: new Uint8Array(v.LIMITS.chunkBytes) };
  v.validateWrite(payload);
  for (const bytes of ['base64', new ArrayBuffer(1), [], new Uint8Array(), new Uint8Array(v.LIMITS.chunkBytes + 1), new Uint8Array(new ArrayBuffer(v.LIMITS.chunkBytes + 1), 0, 1)]) {
    assert.throws(() => v.validateWrite({ ...payload, bytes }));
  }
  if (typeof SharedArrayBuffer !== 'undefined') assert.throws(() => v.validateWrite({ ...payload, bytes: new Uint8Array(new SharedArrayBuffer(8)) }));
  for (const id of ['/etc/passwd', '../x', 'a'.repeat(63), 'g'.repeat(64)]) assert.throws(() => v.validateRead({ id, offset: 0 }));
  for (const offset of [-1, NaN, Infinity, 0.5, v.LIMITS.syncBytes + 1]) assert.throws(() => v.validateRead({ id: token, offset }));
  assert.throws(() => v.validateRelease({ ids: Array(33).fill(token) }));
});

test('HTTP guard requires launch token, loopback, Host and matching Origin before Next', () => {
  const request = {
    headers: { host: '127.0.0.1:43127', [TOKEN_HEADER]: token },
    socket: { remoteAddress: '127.0.0.1' }, url: '/api/people',
    rawHeaders: ['Host', '127.0.0.1:43127', TOKEN_HEADER, token],
  };
  assert.equal(trustedRequest(request, origin, token), true);
  for (const headers of [
    { ...request.headers, [TOKEN_HEADER]: undefined }, { ...request.headers, [TOKEN_HEADER]: 'b'.repeat(64) },
    { ...request.headers, host: 'localhost:43127' }, { ...request.headers, origin: 'https://evil.test' },
    { ...request.headers, [TOKEN_HEADER]: [token] },
  ]) assert.equal(trustedRequest({ ...request, headers }, origin, token), false);
  assert.equal(trustedRequest({ ...request, headers: { ...request.headers, origin } }, origin, token), true);
  assert.equal(trustedRequest({ ...request, socket: { remoteAddress: '192.168.1.2' } }, origin, token), false);
  assert.equal(trustedRequest({ ...request, rawHeaders: [...request.rawHeaders, TOKEN_HEADER, token] }, origin, token), false);
  for (const url of ['https://evil.test', '//evil.test/x']) assert.equal(trustedRequest({ ...request, url }, origin, token), false);
});
