import { PERSON_FIELDS } from '@/lib/person-fields';
import type { ColumnKey, Table, TableSelection } from './types';

export const VIRTUAL_COLUMNS = [
  { key: 'fullName', label: 'ФИО', aliases: ['фио', 'ф. и. о.', 'фамилия имя отчество', 'full name'] },
  { key: 'passportSeries', label: 'Серия паспорта', aliases: ['серия паспорта', 'паспорт серия', 'серия'] },
  { key: 'passportDigits', label: 'Номер паспорта (отдельно от серии)', aliases: ['номер паспорта', 'паспорт номер', 'номер'] },
] as const;
export const IMPORT_COLUMNS = [...PERSON_FIELDS, ...VIRTUAL_COLUMNS];
export function duplicateSplitPassportColumns(columns: TableSelection['columns']) {
  return (['passportSeries', 'passportDigits'] as const).filter((key) => columns.filter((column) => column === key).length > 1);
}
export function headerKey(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
}
export function recognizeHeader(text: string): ColumnKey | null {
  const key = headerKey(text);
  if (!key) return null;
  // Explicit split passport headings take precedence over the registry's combined number alias.
  const columns = [...VIRTUAL_COLUMNS, ...PERSON_FIELDS];
  return (columns.find((f) => [f.label, ...f.aliases, f.key].some((a) => headerKey(a) === key))?.key as ColumnKey) ?? null;
}
export function headings(table: Table, start: number, end: number): string[] {
  const width = Math.max(0, ...table.rows.map((r) => r.cells.length));
  return Array.from({ length: width }, (_, column) => {
    const parts = table.rows.filter((r) => r.number >= start && r.number <= end).map((r) => {
      const cell = r.cells[column];
      if (cell?.mergedFrom) {
        const master = table.rows.find((row) => row.number === cell.mergedFrom!.row)?.cells[cell.mergedFrom.column];
        return master?.text ?? '';
      }
      return cell?.text ?? '';
    }).filter(Boolean);
    return [...new Set(parts)].join(' ');
  });
}
export function suggestSelection(table: Table): TableSelection {
  let best = { start: table.rows[0]?.number ?? 1, end: table.rows[0]?.number ?? 1, score: 0, columns: [] as (ColumnKey | null)[] };
  for (const row of table.rows.slice(0, 20)) {
    for (let span = 0; span < 3; span++) {
      const columns = headings(table, row.number, row.number + span).map(recognizeHeader);
      const unique = new Set(columns.filter(Boolean));
      const score = unique.size * 10 + (unique.has('fullName') ? 10 : 0) + (unique.has('lastName') && unique.has('firstName') ? 10 : 0) - span;
      if (unique.size && score > best.score) best = { start: row.number, end: row.number + span, score, columns };
    }
  }
  return { tableId: table.id, included: best.score > 0, headerStart: best.start, headerEnd: best.end, columns: best.columns.length ? best.columns : headings(table, best.start, best.end).map(() => null) };
}
