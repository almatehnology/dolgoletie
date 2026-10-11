import { readOfficeArchive } from './archive';
import { parseDocx } from './docx';
import { parseXlsx } from './xlsx';
import { ImportError, LIMITS, checkDeadline } from './limits';
import type { Table } from './types';

export async function parseFiles(files: { name: string; buffer: Buffer }[]): Promise<Table[]> {
  if (!files.length || files.length > LIMITS.files) throw new ImportError('FILE_COUNT', 'Выберите от 1 до 12 файлов DOCX/XLSX.');
  if (files.reduce((n, f) => n + f.buffer.length, 0) > LIMITS.uploadBytes) throw new ImportError('UPLOAD_LIMIT', 'Общий размер файлов превышает 30 МБ.', 413);
  const tables: Table[] = [];
  const started = Date.now();
  for (const [i, file] of files.entries()) {
    if (!/\.(docx|xlsx)$/i.test(file.name)) throw new ImportError('FORMAT', `${file.name}: поддерживаются только DOCX и XLSX без пароля.`);
    if (file.buffer.length < 4) throw new ImportError('FORMAT', `${file.name}: файл пуст или повреждён.`);
    const xml = await readOfficeArchive(file.buffer, started);
    const parsed = /\.docx$/i.test(file.name) ? await parseDocx(file.buffer, file.name, `f${i}`, xml, started) : await parseXlsx(file.buffer, file.name, `f${i}`, xml, started);
    tables.push(...parsed);
    if (tables.length > LIMITS.tables || tables.reduce((n, t) => n + t.rows.length, 0) > LIMITS.rows) throw new ImportError('BATCH_LIMIT', 'В пакете более 60 таблиц или 10 000 строк.', 413);
    checkDeadline(started);
  }
  return tables;
}
