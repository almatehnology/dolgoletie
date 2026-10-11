import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import { parseFiles } from '../lib/batch-import/parse';
import { buildPlan } from '../lib/batch-import/plan';
import { JobStore } from '../lib/batch-import/jobs';

test('control batch: 2000 people across 4000 XLSX/DOCX rows fits the bounded job store', async (t) => {
  const count = 2000;
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Контрольный набор'); sheet.addRow(['Фамилия', 'Имя', 'Телефон', 'Дата рождения']);
  const c = (value: string) => `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
  const r = (values: string[]) => `<w:tr>${values.map(c).join('')}</w:tr>`;
  const docRows = [r(['Фамилия', 'Имя', 'Паспорт'])];
  for (let i = 0; i < count; i++) {
    sheet.addRow([`Фамилия${i}`, 'Иван', `+700${String(i).padStart(8, '0')}`, '1980-01-01']);
    docRows.push(r([`Фамилия${i}`, 'Иван', `0011 ${String(i).padStart(6, '0')}`]));
  }
  const archive = archiver('zip'); const chunks: Buffer[] = [];
  const ready = new Promise<Buffer>((resolve, reject) => { archive.on('data', (chunk) => chunks.push(Buffer.from(chunk))); archive.on('end', () => resolve(Buffer.concat(chunks))); archive.on('error', reject); });
  archive.append('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', { name: '[Content_Types].xml' });
  archive.append(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>${docRows.join('')}</w:tbl></w:body></w:document>`, { name: 'word/document.xml' });
  await archive.finalize();
  const files = [{ name: 'people.xlsx', buffer: Buffer.from(await book.xlsx.writeBuffer()) }, { name: 'passports.docx', buffer: await ready }];
  const start = performance.now(); const tables = await parseFiles(files); const parsedMs = performance.now() - start;
  const store = new JobStore(); const job = store.create('synthetic-volume', tables);
  const planStart = performance.now(); job.plan = buildPlan(job, []); const planMs = performance.now() - planStart;
  store.checkSize(job);
  assert.equal(job.plan.groups.length, count); assert.equal(job.plan.ready, count); assert.equal(job.plan.blocked, 0);
  assert.equal(job.plan.groups.every((g) => g.rowIds.length === 2), true);
  t.diagnostic(`2000 people / 4000 source rows; upload ${files.reduce((n, f) => n + f.buffer.length, 0)} bytes; parse ${parsedMs.toFixed(0)} ms; plan ${planMs.toFixed(0)} ms; job ${job.bytes} serialized bytes`);
});
