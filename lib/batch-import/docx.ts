import { XMLParser } from 'fast-xml-parser';
import { readOfficeArchive } from './archive';
import { suggestSelection } from './headers';
import { ImportError, LIMITS, checkDeadline } from './limits';
import type { Cell, Table } from './types';

type XmlNode = { [key: string]: XmlNode[] | Record<string, string> | string };
const children = (node: XmlNode, key: string): XmlNode[] => Array.isArray(node[key]) ? node[key] as XmlNode[] : [];
const child = (nodes: XmlNode[], key: string) => nodes.find((n) => key in n);
function textOf(nodes: XmlNode[]): string {
  return nodes.map((n) => {
    if ('tbl' in n || 'del' in n || 'instrText' in n) return '';
    if ('#text' in n) return String(n['#text']);
    if ('br' in n || 'cr' in n) return '\n';
    if ('tab' in n) return '\t';
    const key = Object.keys(n).find((k) => k !== ':@');
    const text = key ? textOf(children(n, key)) : '';
    return key === 'p' ? text + '\n' : text;
  }).join('');
}
function tablesOf(nodes: XmlNode[]): XmlNode[] {
  const tables: XmlNode[] = [];
  for (const node of nodes) {
    if ('tbl' in node) { tables.push(node); continue; }
    for (const key of Object.keys(node)) if (key !== ':@') tables.push(...tablesOf(children(node, key)));
  }
  return tables;
}
export async function parseDocx(buffer: Buffer, fileName: string, prefix: string, xml?: Map<string, string>, started = Date.now()): Promise<Table[]> {
  const parts = xml ?? await readOfficeArchive(buffer, started);
  const document = parts.get('word/document.xml');
  if (!document || !/wordprocessingml.*main\+xml/.test(parts.get('[Content_Types].xml') ?? '')) throw new ImportError('FORMAT', `${fileName}: содержимое не соответствует DOCX.`);
  // Bound structural allocation before constructing the XML tree, including nested tables.
  let rowCount = 0, tableCount = 0, tokens = 0;
  for (const tag of document.matchAll(/<(?:[\w.-]+:)?([\w.-]+)\b/g)) {
    if (++tokens > 200000) throw new ImportError('XML_COMPLEXITY', 'Документ слишком сложный. Разделите его на меньшие таблицы.', 413);
    if (tag[1] === 'tr' && ++rowCount > LIMITS.rows) throw new ImportError('ROW_LIMIT', 'В документе более 10 000 строк.', 413);
    if (tag[1] === 'tbl' && ++tableCount > LIMITS.tables) throw new ImportError('TABLE_LIMIT', 'Слишком много таблиц.', 413);
  }
  checkDeadline(started);
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: false, processEntities: true });
  const parsed = parser.parse(document) as XmlNode[];
  const nodes = tablesOf(parsed);
  if (!nodes.length) throw new ImportError('NO_TABLES', `${fileName}: таблицы не найдены. Изображения и OCR не поддерживаются.`);
  if (nodes.length > LIMITS.tables) throw new ImportError('TABLE_LIMIT', 'Слишком много таблиц.', 413);
  let totalRows = 0;
  return nodes.map((node, index) => {
    const table: Table = { id: `${prefix}:table:${index + 1}`, fileName, name: `Таблица ${index + 1}`, rows: [], warnings: [], selection: null! };
    const rows = children(node, 'tbl').filter((n) => 'tr' in n);
    totalRows += rows.length;
    if (totalRows > LIMITS.rows) throw new ImportError('ROW_LIMIT', 'В документе более 10 000 строк.', 413);
    const vertical = new Map<number, { row: number; column: number }>();
    rows.forEach((row, rowIndex) => {
      checkDeadline(started);
      const number = rowIndex + 1;
      const cells: Cell[] = [];
      const rowChildren = children(row, 'tr');
      const before = child(children(child(rowChildren, 'trPr') ?? {}, 'trPr'), 'gridBefore');
      const offset = Number((before?.[':@'] as Record<string, string>)?.['@_val'] ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > LIMITS.columns) throw new ImportError('COLUMN_LIMIT', 'Недопустимый сдвиг ячеек.');
      for (let i = 0; i < offset; i++) cells.push({ text: '' });
      for (const tc of rowChildren.filter((n) => 'tc' in n)) {
        const contents = children(tc, 'tc');
        const props = children(child(contents, 'tcPr') ?? {}, 'tcPr');
        const spanNode = child(props, 'gridSpan');
        const span = Number((spanNode?.[':@'] as Record<string, string>)?.['@_val'] ?? 1);
        if (!Number.isInteger(span) || span < 1 || cells.length + span > LIMITS.columns) throw new ImportError('COLUMN_LIMIT', 'В таблице более 100 колонок.', 413);
        const column = cells.length;
        const merge = child(props, 'vMerge');
        const restart = (merge?.[':@'] as Record<string, string>)?.['@_val'] === 'restart';
        const text = textOf(contents).trim();
        if (text.length > LIMITS.cellChars) throw new ImportError('CELL_LIMIT', 'Слишком длинная ячейка.', 413);
        if (merge && !restart) cells.push({ text: '', mergedFrom: vertical.get(column), warning: 'Объединённая ячейка не перенесена на соседнего человека.' });
        else {
          cells.push({ text, kind: 'text', warning: child(contents, 'tbl') ? 'Вложенная таблица не загружена; проверьте ячейку.' : undefined });
          if (restart) vertical.set(column, { row: number, column }); else vertical.delete(column);
        }
        for (let n = 1; n < span; n++) cells.push({ text: '', mergedFrom: { row: number, column } });
      }
      table.rows.push({ number, cells });
    });
    table.selection = suggestSelection(table);
    return table;
  });
}
