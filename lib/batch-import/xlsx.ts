import ExcelJS from 'exceljs';
import { XMLParser } from 'fast-xml-parser';
import { posix } from 'node:path';
import type { Cell, Table } from './types';
import { ImportError, LIMITS, checkDeadline } from './limits';
import { suggestSelection } from './headers';
import { readOfficeArchive } from './archive';
import { excelDate } from './normalize';

function numericText(value: number, format: string | undefined): string {
  const mask = format?.split(';')[0].replace(/"([^\"]*)"/g, '$1').replace(/\\(.)/g, '$1');
  // Preserve explicit zero padding and literal +. Complex formats require review.
  if (mask && /^\+?0+$/.test(mask) && Number.isSafeInteger(value) && value >= 0) {
    return (mask.startsWith('+') ? '+' : '') + String(value).padStart(mask.replace('+', '').length, '0');
  }
  return String(value);
}
function xmlAttribute(tag: string, name: string): string | undefined {
  for (const match of tag.matchAll(/(?:^|\s)([\w:.-]+)\s*=\s*(['"])([\s\S]*?)\2/g)) if (match[1] === name) return match[3];
  return undefined;
}
function checkAddress(address: string): void {
  // Reject attributes we cannot validate (including entity-encoded coordinates)
  // before ExcelJS expands a range. Both XML quote styles and whitespace are valid.
  const match = address.match(/^([A-Z]+)([1-9]\d*)$/);
  if (!match) throw new ImportError('COORDINATE_FORMAT', 'Недопустимая координата XLSX.');
  const column = [...match[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  if (column > LIMITS.columns || Number(match[2]) > LIMITS.rows) throw new ImportError('DIMENSION_LIMIT', 'Размер листа или объединения превышает предел 10 000 строк / 100 колонок.', 413);
}
function readCell(cell: ExcelJS.Cell, earlySerial?: number, date1904 = false): Cell {
  if (cell.isMerged && cell.master.address !== cell.address) return { text: '', mergedFrom: { row: Number(cell.master.row), column: Number(cell.master.col) - 1 } };
  let value = cell.value;
  if (value === null || value === undefined) return { text: '' };
  if (typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    const result = 'result' in value ? value.result : undefined;
    if (result === undefined || result === null) return { text: '', error: 'Формула не имеет сохранённого результата. Исправьте ячейку или исключите поле.' };
    value = result;
  }
  if (value instanceof Date) {
    const date = earlySerial !== undefined ? excelDate(earlySerial, date1904) : value.toISOString().slice(0, 10);
    if (!date) return { text: String(earlySerial), error: 'Недопустимая дата Excel, включая несуществующее 29.02.1900.' };
    return { text: date, kind: 'date', date };
  }
  if (typeof value === 'number') {
    const text = numericText(value, cell.numFmt);
    const simpleFormat = cell.numFmt && /^\+?0+$/.test(cell.numFmt.replace(/"/g, '').replace(/\\/g, ''));
    return { text, kind: 'number', number: value, warning: !Number.isSafeInteger(value) || Math.abs(value) >= 1e15 ? 'Числовая ячейка могла потерять точность. Проверьте исходные цифры.' : !simpleFormat ? 'Числовая ячейка: проверьте ведущие нули, знак + и формат номера.' : undefined };
  }
  if (typeof value === 'object' && 'error' in value) return { text: '', error: `Ошибка Excel ${value.error}; исправьте ячейку.` };
  if (typeof value === 'object' && 'richText' in value) return { text: value.richText.map((r) => r.text).join(''), kind: 'text' };
  if (typeof value === 'object' && 'text' in value) return { text: String(value.text), kind: 'text' };
  return { text: String(value), kind: 'text' };
}
export async function parseXlsx(buffer: Buffer, fileName: string, prefix: string, xml?: Map<string, string>, started = Date.now()): Promise<Table[]> {
  const parts = xml ?? await readOfficeArchive(buffer, started);
  if (!parts.has('xl/workbook.xml') || !parts.has('xl/_rels/workbook.xml.rels') || !/spreadsheetml.*main\+xml/.test(parts.get('[Content_Types].xml') ?? '')) throw new ImportError('FORMAT', `${fileName}: содержимое не соответствует XLSX.`);
  let total = 0;
  for (const [path, text] of parts) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) continue;
    let rowCells = 0;
    for (const match of text.matchAll(/<(?:\w+:)?(row|c|dimension|mergeCell)\b(?:"[^"]*"|'[^']*'|[^'">])*>/g)) {
      checkDeadline(started);
      if (match[1] === 'row') {
        rowCells = 0; total++;
        const number = xmlAttribute(match[0], 'r');
        if (number !== undefined && !/^[1-9]\d*$/.test(number)) throw new ImportError('COORDINATE_FORMAT', 'Недопустимый номер строки XLSX.');
        if (total > LIMITS.rows || (number !== undefined && Number(number) > LIMITS.rows)) throw new ImportError('ROW_LIMIT', 'В файле более 10 000 строк или слишком разреженный лист.', 413);
      } else if (match[1] === 'c') {
        if (++rowCells > LIMITS.columns) throw new ImportError('COLUMN_LIMIT', 'В листе более 100 колонок.', 413);
        const address = xmlAttribute(match[0], 'r'); if (address !== undefined) checkAddress(address);
      } else {
        const ref = xmlAttribute(match[0], 'ref');
        if (!ref || ref.split(':').length > 2) throw new ImportError('COORDINATE_FORMAT', 'Недопустимый диапазон XLSX.');
        ref.split(':').forEach(checkAddress);
      }
    }
  }
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]); }
  catch { throw new ImportError('XLSX_INVALID', `${fileName}: не удалось прочитать книгу. Проверьте формат и отсутствие пароля.`); }
  checkDeadline(started);
  // ExcelJS uses the post-March-1900 epoch for Date cells. Retain original early
  // serials so Jan/Feb 1900 do not move by a day and the fictitious serial 60 rejects.
  const metadata = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const asArray = <T,>(v: T | T[] | undefined): T[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
  const sheetMeta = asArray(metadata.parse(parts.get('xl/workbook.xml')!).workbook?.sheets?.sheet) as Record<string, string>[];
  const relationships = asArray(metadata.parse(parts.get('xl/_rels/workbook.xml.rels')!).Relationships?.Relationship) as Record<string, string>[];
  const earlyDates = new Map<string, Map<string, number>>();
  for (const meta of sheetMeta) {
    const target = relationships.find((r) => r['@_Id'] === meta['@_id'])?.['@_Target'];
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : posix.normalize(`xl/${target}`);
    const text = parts.get(path); if (!text) continue;
    const dates = new Map<string, number>();
    for (const match of text.matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
      const address = xmlAttribute(match[1], 'r');
      const raw = match[2].match(/<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/)?.[1];
      if (address && raw && Number.isFinite(Number(raw)) && Number(raw) <= 60) dates.set(address, Number(raw));
    }
    earlyDates.set(meta['@_name'], dates);
  }
  const tables: Table[] = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > LIMITS.rows || sheet.columnCount > LIMITS.columns) throw new ImportError('TABLE_LIMIT', 'Размер листа превышает предел.', 413);
    const table: Table = { id: `${prefix}:sheet:${sheet.id}`, fileName, name: sheet.name, rows: [], date1904: workbook.properties.date1904, warnings: sheet.state !== 'visible' ? ['Лист скрыт в исходном файле.'] : [], selection: null! };
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      checkDeadline(started);
      const cells = Array.from({ length: sheet.columnCount }, (_, col) => { const cell = row.getCell(col + 1); return readCell(cell, earlyDates.get(sheet.name)?.get(cell.address), workbook.properties.date1904); });
      if (cells.some((c) => c.text.length > LIMITS.cellChars)) throw new ImportError('CELL_LIMIT', 'Слишком длинное значение ячейки.', 413);
      table.rows.push({ number, cells });
    });
    if (table.rows.length) { table.selection = suggestSelection(table); tables.push(table); }
  }
  if (!tables.length) throw new ImportError('NO_TABLES', `${fileName}: нет непустых листов.`);
  if (tables.length > LIMITS.tables) throw new ImportError('TABLE_LIMIT', 'Слишком много листов.', 413);
  return tables;
}
