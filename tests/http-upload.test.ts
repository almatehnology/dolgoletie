import test from 'node:test';
import assert from 'node:assert/strict';
import { readUploadForm } from '../lib/http-upload';
import { ARCHIVE_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } from '../lib/transfer-limits';

async function errorCode(promise: Promise<unknown>, code: string, status = 400) {
  await assert.rejects(promise, asyncError => asyncError instanceof Response && asyncError.status === status);
  // Callers expose only fixed messages; they never echo file bytes or passwords.
  const error = await promise.catch(value => value as Response);
  assert.ok(error instanceof Response);
  assert.equal((await error.json()).error.code, code);
}

test('multipart preserves binary files, filenames and accompanying fields', async () => {
  const body = new FormData();
  const bytes = new Uint8Array([0, 255, 13, 10, 128, 42]);
  body.append('file', new Blob([bytes]), 'архив.tdbsync');
  body.append('password', 'synthetic-password');
  body.append('mode', 'merge');
  const request = new Request('http://localhost/api/import', { method: 'POST', body });
  const parsed = await readUploadForm(request, 4096);
  assert.equal(parsed.get('password'), 'synthetic-password');
  assert.equal(parsed.get('mode'), 'merge');
  const file = parsed.get('file') as File;
  assert.equal(file.name, 'архив.tdbsync');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
});

test('rejects oversized declared and streamed bodies before multipart decoding', async () => {
  await errorCode(readUploadForm(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': '2048' }, body: 'short' }), 1024), 'UPLOAD_LIMIT', 413);
  await errorCode(readUploadForm(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body: 'more-than-limit' }), 5), 'UPLOAD_LIMIT', 413);
});

test('distinguishes truncated transfers from invalid multipart and unsupported formats', async () => {
  await errorCode(readUploadForm(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': '100' }, body: 'short' }), 1024), 'UPLOAD_INCOMPLETE');
  await errorCode(readUploadForm(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body: 'not a multipart document' }), 1024), 'UPLOAD_INVALID');
  await errorCode(readUploadForm(new Request('http://localhost', { method: 'POST', body: 'not-a-file' }), 1024), 'UPLOAD_FORMAT');
});

test('one GiB transfer is admitted to decoding, larger-than-request-budget declarations fail immediately', async () => {
  const request = (size: number) => new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': String(size) }, body: 'short' });
  // Metadata-only boundary check: the short fixture is incomplete, not oversized.
  await errorCode(readUploadForm(request(ARCHIVE_MAX_BYTES + 1024), UPLOAD_REQUEST_MAX_BYTES), 'UPLOAD_INCOMPLETE');
  await errorCode(readUploadForm(request(UPLOAD_REQUEST_MAX_BYTES + 1), UPLOAD_REQUEST_MAX_BYTES), 'UPLOAD_LIMIT', 413);
});
