import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import sharp from 'sharp';

export const ADMIN_PASSWORD = 'Synthetic-admin-2026!';
export const USERNAME = 'qa-primary';
export const USER_PASSWORD = 'Synthetic-primary-2026!';

// Alphabetic names exercise normal full-name parsing without ambiguous digit suffixes.
export function syntheticSurname(index: number) {
  const alphabet = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';
  return `Тестовый${(index - 1).toString(32).padStart(3, '0').split('').map(char => alphabet[parseInt(char, 32)]).join('')}`;
}

export async function createFixtures(root: string) {
  const xlsx = join(root, 'fixtures', 'synthetic-people.xlsx');
  const docx = join(root, 'fixtures', 'synthetic-people.docx');
  const scan = join(root, 'fixtures', 'synthetic-document.png');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Синтетика');
  sheet.addRow(['ВЫМЫШЛЕННЫЕ ДАННЫЕ ДЛЯ QA']);
  sheet.mergeCells('A1:E1');
  sheet.addRow(['ФИО', 'Моб. телефон', 'Дата рождения', 'QA комментарий', 'Серия и номер паспорта']);
  for (let i = 1; i <= 51; i++) {
    sheet.addRow([`${syntheticSurname(i)} Турист Синтетический`, `+7000000${String(i).padStart(4, '0')}`, new Date('1980-02-29T00:00:00Z'), `Вымышленная запись ${i}`, `0000 ${String(i).padStart(6, '0')}`]);
    sheet.getCell(`C${i + 2}`).numFmt = 'dd.mm.yyyy';
  }
  sheet.addRow(['Импортный Роман Тестович', '', '', 'Дополнение по выбранной вручную карточке', '']);
  await book.xlsx.writeFile(xlsx);
  const esc = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const cell = (text: string) => `<w:tc><w:p><w:r><w:t>${esc(text)}</w:t></w:r></w:p></w:tc>`;
  const row = (values: string[]) => `<w:tr>${values.map(cell).join('')}</w:tr>`;
  const rows = [
    ['ФИО', 'Телефон', 'Примечания', 'Серия паспорта', 'Номер паспорта'],
    ['Конфликтов Антон Тестович', '+70000009999', '', '0001', '000001'],
    ['Документова Анна Тестовна', '+70000008888', 'Вымышленная запись из DOCX', '0002', '000002'],
  ];
  const archive = archiver('zip');
  const chunks: Buffer[] = [];
  archive.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => { archive.on('end', () => resolve(Buffer.concat(chunks))); archive.on('error', reject); });
  archive.append('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', { name: '[Content_Types].xml' });
  archive.append(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>${rows.map(row).join('')}</w:tbl></w:body></w:document>`, { name: 'word/document.xml' });
  await archive.finalize();
  await writeFile(docx, await done);
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><rect width="600" height="360" fill="#e8edf6"/><text x="30" y="150" font-size="28">SYNTHETIC QA DOCUMENT</text><text x="30" y="200" font-size="18">No real identity or passport information</text></svg>')).png().toFile(scan);
  return { xlsx, docx, scan };
}
