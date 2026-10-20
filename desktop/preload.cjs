'use strict';

// Sandboxed preload cannot require local CJS modules. Keep this file self-contained.
const { contextBridge, ipcRenderer } = require('electron');
const CHUNK_BYTES = 256 * 1024;
const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
const capability = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Недопустимая передача');
  return value;
};
const offset = (value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > ARCHIVE_MAX_BYTES) throw new Error('Недопустимая позиция');
  return value;
};

contextBridge.exposeInMainWorld('travelDesktop', Object.freeze({
  version: 1,
  selectFiles: (options) => {
    if (!options || !['tables', 'sync'].includes(options.kind)) throw new Error('Недопустимый вид файлов');
    return ipcRenderer.invoke('tdb:files:select', { kind: options.kind });
  },
  readFileChunk: (id, position) => ipcRenderer.invoke('tdb:files:read', { id: capability(id), offset: offset(position) }),
  releaseFiles: (ids) => {
    if (!Array.isArray(ids) || ids.length > 32) throw new Error('Недопустимый список передач');
    return ipcRenderer.invoke('tdb:files:release', { ids: ids.map(capability) });
  },
  beginSave: (filename, size) => {
    if (typeof filename !== 'string' || filename.length > 180 || !Number.isSafeInteger(size) || size < 0 || size > ARCHIVE_MAX_BYTES) throw new Error('Недопустимый файл');
    return ipcRenderer.invoke('tdb:files:save-begin', { filename, size });
  },
  writeSaveChunk: (id, position, bytes) => {
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) ||
        !bytes.length || bytes.length > CHUNK_BYTES || bytes.buffer.byteLength > CHUNK_BYTES) throw new Error('Недопустимый блок');
    return ipcRenderer.invoke('tdb:files:save-write', { id: capability(id), offset: offset(position), bytes });
  },
  finishSave: (id) => ipcRenderer.invoke('tdb:files:save-commit', { id: capability(id) }),
  cancelSave: (id) => ipcRenderer.invoke('tdb:files:save-abort', { id: capability(id) }),
}));
