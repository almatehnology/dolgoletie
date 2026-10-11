import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDownloadName } from '../lib/file-names';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateFilename } = require('../desktop/validation.cjs');
test('report filenames satisfy native Windows and UTF-8 name restrictions', () => {
  for (const title of ['CON', 'CONIN$', 'CONOUT$', 'COM1 .jpg', 'LPT¹', 'Я'.repeat(100), '🌍'.repeat(100), 'Поездка Москва/СПб: участники', '..', 'Отчёт. ']) for (const format of ['pdf', 'xlsx', 'jpg', 'png', 'webp'] as const) {
    const name = safeDownloadName(title, format);
    assert.ok(Buffer.byteLength(name) <= 180);
    assert.doesNotThrow(() => validateFilename(name));
    assert.ok(name.endsWith(`.${format}`));
  }
});
