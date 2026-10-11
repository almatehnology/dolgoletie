'use strict';

const LIMITS = Object.freeze({
  chunkBytes: 256 * 1024,
  tableFileBytes: 32 * 1024 * 1024,
  tableTotalBytes: 128 * 1024 * 1024,
  tableFiles: 32,
  syncBytes: 512 * 1024 * 1024,
  reportBytes: 64 * 1024 * 1024,
  idleMs: 2 * 60 * 1000,
  lifetimeMs: 30 * 60 * 1000,
});

const CHANNELS = Object.freeze({
  select: 'tdb:files:select',
  read: 'tdb:files:read',
  release: 'tdb:files:release',
  beginSave: 'tdb:files:save-begin',
  write: 'tdb:files:save-write',
  commit: 'tdb:files:save-commit',
  abort: 'tdb:files:save-abort',
});

const MIME = Object.freeze({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.tdbsync': 'application/octet-stream',
  '.tdbbackup': 'application/octet-stream',
});

function fail(message = 'Недопустимый запрос desktop') {
  throw new Error(message);
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail();
}

function validOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      Number(url.port) > 0 && url.origin === origin;
  } catch { return false; }
}

function sameOrigin(urlString, origin) {
  if (!validOrigin(origin) || typeof urlString !== 'string' || urlString.length > 8192) return false;
  try {
    const url = new URL(urlString);
    return url.origin === origin && !url.username && !url.password && url.protocol === 'http:';
  } catch { return false; }
}

function validateSender({ senderId, expectedSenderId, isMainFrame, frameUrl, origin }) {
  if (!Number.isSafeInteger(expectedSenderId) || senderId !== expectedSenderId ||
      isMainFrame !== true || !sameOrigin(frameUrl, origin)) fail('Недоверенный отправитель desktop IPC');
}

function extension(filename) {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

// Portable basenames only: disallow traversal, drive names, NTFS streams and device names.
function validateFilename(value) {
  if (typeof value !== 'string' || !value.length || value.length > 180 || Buffer.byteLength(value, 'utf8') > 180 ||
      value.trim() !== value || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value) ||
      /[. ]$/u.test(value) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(value) ||
      value === '.' || value === '..') fail('Недопустимое имя файла');
  return value;
}

function validateSelect(value) {
  exactObject(value, ['kind']);
  if (value.kind !== 'tables' && value.kind !== 'sync') fail();
  return value.kind;
}

function validateId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('Недопустимый идентификатор передачи');
  return value;
}

function validateIdRequest(value) {
  exactObject(value, ['id']);
  return validateId(value.id);
}

function validateRelease(value) {
  exactObject(value, ['ids']);
  if (!Array.isArray(value.ids) || value.ids.length > LIMITS.tableFiles) fail();
  return value.ids.map(validateId);
}

function validateRead(value) {
  exactObject(value, ['id', 'offset']);
  validateId(value.id);
  if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > LIMITS.syncBytes) fail();
  return value;
}

function validateSave(value) {
  exactObject(value, ['filename', 'size']);
  validateFilename(value.filename);
  const ext = extension(value.filename);
  if (!['.pdf', '.xlsx', '.jpg', '.jpeg', '.png', '.webp', '.zip', '.tdbsync', '.tdbbackup'].includes(ext)) fail('Этот формат нельзя сохранить');
  const limit = ['.zip', '.tdbsync', '.tdbbackup'].includes(ext) ? LIMITS.syncBytes : LIMITS.reportBytes;
  if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > limit) fail('Файл превышает лимит');
  return value;
}

function validateWrite(value) {
  exactObject(value, ['id', 'offset', 'bytes']);
  validateRead({ id: value.id, offset: value.offset });
  // IPC accepts a bounded typed array, never strings/base64, Blob, paths or shared memory.
  if (!(value.bytes instanceof Uint8Array) || !(value.bytes.buffer instanceof ArrayBuffer) ||
      value.bytes.byteLength === 0 || value.bytes.byteLength > LIMITS.chunkBytes ||
      value.bytes.buffer.byteLength > LIMITS.chunkBytes) fail('Недопустимый размер блока IPC');
  return value;
}

function validateSelectedFile(kind, filename, size) {
  validateSelect({ kind });
  validateFilename(filename);
  const allowed = kind === 'tables' ? ['.docx', '.xlsx'] : ['.zip', '.tdbsync'];
  if (!allowed.includes(extension(filename))) fail('Недопустимое расширение выбранного файла');
  const limit = kind === 'tables' ? LIMITS.tableFileBytes : LIMITS.syncBytes;
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) fail('Файл превышает лимит');
}

function validateSelectionCount(kind, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > (kind === 'tables' ? LIMITS.tableFiles : 1)) fail('Слишком много файлов');
}

module.exports = {
  LIMITS, CHANNELS, MIME, validOrigin, sameOrigin, validateSender, extension,
  validateFilename, validateSelect, validateId, validateIdRequest, validateRelease,
  validateRead, validateSave, validateWrite, validateSelectedFile, validateSelectionCount,
};
