'use strict';

const { open, lstat, rename, unlink } = require('node:fs/promises');
const { constants } = require('node:fs');
const { basename, dirname, join, extname } = require('node:path');
const { randomBytes } = require('node:crypto');
const v = require('./validation.cjs');

const id = () => randomBytes(32).toString('hex');
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

async function destinationIdentity(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Выберите обычный файл для сохранения');
    return identity(stat);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// One broker per window. Paths exist only here, originating exclusively from native dialogs.
class FileBroker {
  constructor({ selectDialog, saveDialog, now = Date.now }) {
    this.selectDialog = selectDialog;
    this.saveDialog = saveDialog;
    this.now = now;
    this.reads = new Map();
    this.saves = new Map();
    this.generation = 0;
    this.active = null;
    this.invalidating = null;
  }

  async operation(assertSender, work) {
    if (this.active || this.invalidating) throw new Error('Дождитесь завершения файловой операции');
    const generation = this.generation;
    const check = () => {
      assertSender();
      if (this.generation !== generation) throw new Error('Передача отменена');
    };
    check();
    const task = Promise.resolve().then(async () => {
      check();
      await this.expire();
      check();
      return work(check);
    });
    this.active = task;
    try { return await task; }
    finally { if (this.active === task) this.active = null; }
  }

  async dropRead(key) {
    const record = this.reads.get(key);
    this.reads.delete(key);
    if (record) await record.handle.close();
  }

  async dropSave(key) {
    const record = this.saves.get(key);
    if (!record) return;
    record.aborted = true;
    try { await record.handle.close(); }
    finally {
      try { await unlink(record.temp); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.saves.delete(key);
    }
  }

  async expire() {
    const expired = (record) => record.aborted || this.now() - record.touched > v.LIMITS.idleMs ||
      this.now() - record.created > v.LIMITS.lifetimeMs;
    for (const [key, record] of this.reads) if (expired(record)) await this.dropRead(key);
    for (const [key, record] of this.saves) if (expired(record)) await this.dropSave(key);
  }

  revoke() {
    this.generation++;
    if (this.invalidating) return this.invalidating;
    const cleanup = (async () => {
      await this.active?.catch(() => {});
      const results = await Promise.allSettled([
        ...Array.from(this.reads.keys(), (key) => this.dropRead(key)),
        ...Array.from(this.saves.keys(), (key) => this.dropSave(key)),
      ]);
      if (results.some((result) => result.status === 'rejected')) throw new Error('Не удалось очистить временный файл');
    })();
    this.invalidating = cleanup;
    cleanup.finally(() => { this.invalidating = null; }).catch(() => {});
    return cleanup;
  }

  select(payload, assertSender) {
    const kind = v.validateSelect(payload);
    return this.operation(assertSender, async (check) => {
      if (this.reads.size) throw new Error('Предыдущий выбор файлов ещё читается');
      const paths = await this.selectDialog(kind);
      check();
      if (paths === null) return null;
      v.validateSelectionCount(kind, paths.length);
      if (new Set(paths).size !== paths.length) throw new Error('Файл выбран повторно');
      const selected = [];
      let total = 0;
      try {
        for (const path of paths) {
          const name = basename(path);
          const before = await lstat(path);
          check();
          if (!before.isFile() || before.isSymbolicLink()) throw new Error('Выберите обычный файл');
          v.validateSelectedFile(kind, name, before.size);
          const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          const key = id();
          this.reads.set(key, { handle, offset: 0, created: this.now(), touched: this.now() });
          const stat = await handle.stat();
          check();
          if (!stat.isFile() || identity(before) !== identity(stat)) throw new Error('Файл изменился во время выбора');
          total += stat.size;
          if (total > (kind === 'tables' ? v.LIMITS.tableTotalBytes : v.LIMITS.syncBytes)) throw new Error('Выбранные файлы превышают общий лимит');
          Object.assign(this.reads.get(key), { size: stat.size, identity: identity(stat) });
          selected.push({ id: key, name, size: stat.size, lastModified: stat.mtimeMs, mimeType: v.MIME[v.extension(name)] });
        }
        check();
        return selected;
      } catch (error) {
        await Promise.allSettled(Array.from(this.reads.keys(), (key) => this.dropRead(key)));
        throw error;
      }
    });
  }

  read(payload, assertSender) {
    v.validateRead(payload);
    return this.operation(assertSender, async (check) => {
      const record = this.reads.get(payload.id);
      if (!record || record.offset !== payload.offset) throw new Error('Недействительная передача или позиция чтения');
      try {
        if (identity(await record.handle.stat()) !== record.identity) throw new Error('Выбранный файл изменился');
        check();
        const buffer = Buffer.alloc(Math.min(v.LIMITS.chunkBytes, record.size - record.offset));
        let received = 0;
        while (received < buffer.length) {
          const { bytesRead } = await record.handle.read(buffer, received, buffer.length - received, record.offset + received);
          check();
          if (!bytesRead) throw new Error('Выбранный файл усечён');
          received += bytesRead;
        }
        if (identity(await record.handle.stat()) !== record.identity) throw new Error('Выбранный файл изменился');
        check();
        record.offset += received;
        record.touched = this.now();
        if (record.offset === record.size) await this.dropRead(payload.id);
        check();
        return new Uint8Array(buffer);
      } catch (error) { await this.dropRead(payload.id); throw error; }
    });
  }

  release(payload, assertSender) {
    const keys = v.validateRelease(payload);
    return this.operation(assertSender, async (check) => {
      for (const key of keys) await this.dropRead(key);
      check();
    });
  }

  beginSave(payload, assertSender) {
    v.validateSave(payload);
    return this.operation(assertSender, async (check) => {
      if (this.saves.size) throw new Error('Предыдущее сохранение ещё не завершено');
      const target = await this.saveDialog(payload.filename);
      check();
      if (target === null) return null;
      v.validateFilename(basename(target));
      if (extname(target).toLowerCase() !== v.extension(payload.filename)) throw new Error('Расширение файла должно соответствовать формату');
      const previous = await destinationIdentity(target);
      check();
      const key = id();
      const temp = join(dirname(target), `.${basename(target)}.${key}.tmp`);
      const handle = await open(temp, 'wx', 0o600);
      this.saves.set(key, { handle, target, temp, previous, size: payload.size, offset: 0, created: this.now(), touched: this.now() });
      try { check(); return { id: key, chunkBytes: v.LIMITS.chunkBytes }; }
      catch (error) { await this.dropSave(key); throw error; }
    });
  }

  write(payload, assertSender) {
    v.validateWrite(payload);
    return this.operation(assertSender, async (check) => {
      const record = this.saves.get(payload.id);
      if (!record || record.aborted) throw new Error('Недействительная передача');
      try {
        if (record.offset !== payload.offset || record.offset + payload.bytes.length > record.size) throw new Error('Недопустимая позиция или длина записи');
        let written = 0;
        while (written < payload.bytes.length) {
          const result = await record.handle.write(payload.bytes, written, payload.bytes.length - written, record.offset + written);
          check();
          if (!result.bytesWritten) throw new Error('Не удалось записать файл');
          written += result.bytesWritten;
        }
        record.offset += written;
        record.touched = this.now();
        return record.offset;
      } catch (error) { await this.dropSave(payload.id); throw error; }
    });
  }

  commit(payload, assertSender) {
    const key = v.validateIdRequest(payload);
    return this.operation(assertSender, async (check) => {
      const record = this.saves.get(key);
      if (!record || record.aborted) throw new Error('Недействительная передача');
      try {
        if (record.offset !== record.size) throw new Error('Файл передан не полностью');
        await record.handle.sync();
        check();
        if (await destinationIdentity(record.target) !== record.previous) throw new Error('Файл назначения изменился; повторите сохранение');
        const tempStat = await lstat(record.temp);
        if (!tempStat.isFile() || tempStat.isSymbolicLink() || identity(tempStat) !== identity(await record.handle.stat())) throw new Error('Временный файл изменился');
        await record.handle.close();
        check();
        // Same directory/filesystem: never unlink the destination as a Windows workaround.
        await rename(record.temp, record.target);
        this.saves.delete(key);
        return true;
      } catch (error) { await this.dropSave(key); throw error; }
    });
  }

  abort(payload, assertSender) {
    const key = v.validateIdRequest(payload);
    return this.operation(assertSender, async (check) => { await this.dropSave(key); check(); });
  }
}

module.exports = { FileBroker };
