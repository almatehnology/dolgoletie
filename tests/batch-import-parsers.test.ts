import test from 'node:test';
import assert from 'node:assert/strict';
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { parseFiles } from '../lib/batch-import/parse';
import { headings, recognizeHeader } from '../lib/batch-import/headers';
import { extractRows } from '../lib/batch-import/rows';
import { calendarDate, excelDate } from '../lib/batch-import/normalize';
import { parseXlsx } from '../lib/batch-import/xlsx';

async function zip(parts: Record<string, string>): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => { archive.on('end', () => resolve(Buffer.concat(chunks))); archive.on('error', reject); });
  for (const [name, text] of Object.entries(parts)) archive.append(text, { name });
  await archive.finalize(); return done;
}
const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const doc = (body: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const cell = (text: string, props = '') => `<w:tc>${props}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`;

test('XLSX detects headings after a title, preserves padding/+ and merges across files', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Люди');
  sheet.addRow(['Список туристов']); sheet.mergeCells('A1:C1');
  sheet.addRow(['Ф. И. О.', 'Моб. телефон', 'Дата рождения']);
  sheet.addRow(['Семёнова Анна Ивановна', 1234567, new Date('1980-02-29T00:00:00Z')]);
  sheet.getCell('B3').numFmt = '"+"0000000000';
  sheet.getCell('C3').numFmt = 'dd.mm.yyyy';
  sheet.addRow(['Ф. И. О.', 'Моб. телефон', 'Дата рождения']);
  sheet.addRow(['Семёнова Анна Ивановна', { formula: '1+1' }, '31.02.2020']);
  const tables = await parseFiles([{ name: 'данные.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) }]);
  assert.equal(tables[0].selection.headerStart, 2);
  const rows = extractRows(tables);
  assert.equal(rows.length, 2); assert.equal(rows[0].values.phone?.[0].value, '+0001234567');
  assert.equal(rows[0].values.birthDate?.[0].value, '1980-02-29');
  assert.ok(rows[1].errors.some((e) => e.includes('Формула'))); assert.ok(rows[1].errors.some((e) => e.includes('дата')));
});
test('1904 dates and formatted numeric passports survive without timezone changes', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.properties.date1904 = true;
  const sheet = workbook.addWorksheet('1904');
  sheet.addRow(['Фамилия', 'Имя', 'Дата рождения', 'Паспорт']);
  sheet.addRow(['Иванов', 'Иван', new Date('1970-01-01T00:00:00Z'), 123456]);
  sheet.getCell('C2').numFmt = 'dd.mm.yyyy'; sheet.getCell('D2').numFmt = '0000000000';
  const rows = extractRows(await parseFiles([{ name: '1904.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) }]));
  assert.equal(rows[0].values.birthDate?.[0].value, '1970-01-01');
  assert.equal(rows[0].values.passportNumber?.[0].value, '0000123456');
  assert.equal(excelDate(0, true), '1904-01-01'); assert.equal(excelDate(60), null);
});
test('styled Excel dates in January/February 1900 keep the day and fictitious leap day rejects', async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Dates'); sheet.addRow(['Фамилия', 'Имя', 'Дата рождения']);
  for (const serial of [1, 59, 60]) { const row = sheet.addRow(['Иванов', 'Иван', serial]); row.getCell(3).numFmt = 'dd.mm.yyyy'; }
  const rows = extractRows(await parseFiles([{ name: 'dates.xlsx', buffer: Buffer.from(await book.xlsx.writeBuffer()) }]));
  assert.equal(rows[0].values.birthDate?.[0].value, '1900-01-01'); assert.equal(rows[1].values.birthDate?.[0].value, '1900-02-28'); assert.ok(rows[2].errors.some((e) => e.includes('29.02.1900')));
});
test('DOCX preserves tables, runs, leading zeros and does not spread merged cells', async () => {
  const body = `<w:tbl>${row(cell('ФИО'), cell('Серия паспорта'), cell('Номер паспорта'))}${row(cell('Петров Пётр Петрович'), cell('0012'), cell('000345'))}</w:tbl><w:tbl>${row(cell('Фамилия'), cell('Имя'), cell('Телефон'))}${row(cell('Сидоров'), cell('Сидор'), cell('+70000000000', '<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>'))}${row(cell('Сидорова'), cell('Анна'), cell('', '<w:tcPr><w:vMerge/></w:tcPr>'))}</w:tbl>`;
  const tables = await parseFiles([{ name: 'список.docx', buffer: await zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': doc(body) }) }]);
  assert.equal(tables.length, 2);
  const rows = extractRows(tables);
  assert.equal(rows[0].values.passportNumber?.[0].value, '0012 000345');
  assert.equal(rows[2].values.phone, undefined); assert.ok(rows[2].warnings.length);
  assert.equal(rows[0].sources[0].row, 2);
});
test('two-row DOCX headings use merged masters only in headings', async () => {
  const body = `<w:tbl>${row(cell('ФИО', '<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>'), cell('Паспорт', '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>'))}${row(cell('', '<w:tcPr><w:vMerge/></w:tcPr>'), cell('Серия'), cell('Номер'))}${row(cell('Иванов Иван Иванович'), cell('0011'), cell('123456'))}</w:tbl>`;
  const [table] = await parseFiles([{ name: 'multi.docx', buffer: await zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': doc(body) }) }]);
  assert.deepEqual(headings(table, 1, 2).map(recognizeHeader), ['fullName', 'passportSeries', 'passportDigits']);
  assert.equal(table.selection.headerEnd, 2);
});
test('unsafe archive paths, entities, malformed XML, wrong formats and unsupported files reject', async () => {
  const valid = { '[Content_Types].xml': contentTypes, 'word/document.xml': doc('<w:tbl/>') };
  // Archiver sanitizes paths; duplicate members still exercise strict archive validation.
  await assert.rejects(parseFiles([{ name: 'file.xls', buffer: Buffer.from('bad') }]), /DOCX/);
  await assert.rejects(parseFiles([{ name: 'file.xlsx', buffer: await zip(valid) }]), /XLSX/);
  await assert.rejects(parseFiles([{ name: 'file.docx', buffer: await zip({ ...valid, 'word/document.xml': '<!DOCTYPE foo [<!ENTITY x "boom">]><foo>&x;</foo>' }) }]), /DTD/);
  await assert.rejects(parseFiles([{ name: 'file.docx', buffer: await zip({ ...valid, 'word/document.xml': '<broken>' }) }]), /XML/);
  await assert.rejects(parseFiles([{ name: 'file.docx', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }]), /паролем/);
  const archive = await zip(valid);
  // Same-length path substitution leaves the ZIP offsets valid while inserting traversal.
  const unsafe = Buffer.from(archive.toString('latin1').replaceAll('word/document.xml', '../x/document.xml'), 'latin1');
  await assert.rejects(parseFiles([{ name: 'file.docx', buffer: unsafe }]), /путь/);
});
test('large sparse workbook and oversized XML are rejected before ExcelJS allocates rows', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Sparse').getCell('A10001').value = 'ФИО';
  await assert.rejects(parseFiles([{ name: 'sparse.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) }]), /10 000|предел/);
  await assert.rejects(parseFiles([{ name: 'big.docx', buffer: await zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': ' '.repeat(12 * 1024 * 1024 + 1) }) }]), /велика/);
});
test('calendar dates reject impossible and ambiguous values', () => {
  assert.equal(calendarDate('29.02.2024'), '2024-02-29'); assert.equal(calendarDate('29.02.2023'), null);
  assert.equal(calendarDate('03/04/2020'), null); assert.equal(calendarDate('2020-13-01'), null);
});
test('review regression: single-quoted XLSX ranges/coordinates reject before workbook loading', async (t) => {
  let loads = 0;
  t.mock.method(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx), 'load', async () => { loads++; throw new Error('Workbook allocation must not be reached'); });
  const xlsxType = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
  for (const xml of ["<worksheet><mergeCells><mergeCell ref='A1:B10001'/></mergeCells></worksheet>", "<worksheet><dimension ref = 'A1:CW1'/></worksheet>", "<worksheet><sheetData><row r = '10001'><c r='A10001'/></row></sheetData></worksheet>", "<worksheet><sheetData><row r='1'><c r = 'CW1'/></row></sheetData></worksheet>"]) {
    const buffer = await zip({ '[Content_Types].xml': xlsxType, 'xl/workbook.xml': '<workbook/>', 'xl/_rels/workbook.xml.rels': '<Relationships/>', 'xl/worksheets/sheet1.xml': xml });
    await assert.rejects(parseXlsx(buffer, 'unsafe.xlsx', 'f0'), /предел|100|10 000/);
  }
  assert.equal(loads, 0);
});
