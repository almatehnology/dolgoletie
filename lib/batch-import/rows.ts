import { PERSON_FIELDS, type PersonFieldKey } from '@/lib/person-fields';
import { cleanText, normalizeValue, splitFullName } from './normalize';
import { duplicateSplitPassportColumns, recognizeHeader } from './headers';
import type { ImportRow, RowEdit, Source, Table, ValueSource } from './types';

export function extractRows(tables: Table[], edits: RowEdit[] = []): ImportRow[] {
  const editMap = new Map(edits.map((e) => [e.rowId, e]));
  const result: ImportRow[] = [];
  for (const table of tables.filter((t) => t.selection.included)) {
    const selection = table.selection;
    const duplicatePassport = duplicateSplitPassportColumns(selection.columns);
    for (const rawRow of table.rows.filter((r) => r.number > selection.headerEnd)) {
      if (!rawRow.cells.some((c) => c.text || c.error || c.warning)) continue;
      const mapped = rawRow.cells.map((c, i) => ({ cell: c, key: selection.columns[i], i })).filter((c) => c.key);
      const nonempty = mapped.filter((c) => cleanText(c.cell.text));
      if (nonempty.length && !rawRow.cells.some((c) => c.error) && nonempty.every((c) => recognizeHeader(c.cell.text) === c.key)) continue;
      const id = `${table.id}:row:${rawRow.number}`;
      const edit = editMap.get(id);
      const isTotal = /^(итого|всего|total|примечание)(?:\s|:|$)/iu.test(cleanText(rawRow.cells.find((c) => c.text)?.text ?? ''));
      const row: ImportRow = { id, sources: [], values: {}, errors: [], warnings: isTotal ? ['Итоговая строка исключена; при необходимости включите её вручную.'] : [], excluded: edit?.excluded ?? isTotal };
      if (duplicatePassport.length) row.errors.push('Повторные колонки серии или номера паспорта: оставьте одно соответствие каждого вида.');
      const add = (key: PersonFieldKey, value: string, source: Source) => {
        if (value) (row.values[key] ??= []).push({ value, source });
      };
      let series: ValueSource | undefined;
      let digits: ValueSource | undefined;
      for (const { cell, key, i } of mapped) {
        const source: Source = { fileName: table.fileName, table: table.name, row: rawRow.number, column: i + 1, raw: cell.text };
        row.sources.push(source);
        if (!key) continue;
        if (cell.mergedFrom) { row.warnings.push(`Колонка ${i + 1}: объединённая ячейка не скопирована.`); continue; }
        if (cell.warning && (['phone', 'passportNumber', 'passportSeries', 'passportDigits'].includes(key) || cell.kind !== 'number')) row.warnings.push(`Колонка ${i + 1}: ${cell.warning}`);
        if (key === 'fullName') {
          if (cell.error && !edit?.values?.lastName) row.errors.push(`ФИО: ${cell.error}`);
          if (!cell.text) continue;
          const split = splitFullName(cell.text);
          if (split.warning) row.warnings.push(split.warning);
          for (const name of ['lastName', 'firstName', 'middleName'] as const) if (edit?.values?.[name] === undefined) add(name, split[name], source);
        } else if (key === 'passportSeries' || key === 'passportDigits') {
          // Invalid duplicate split mappings are rejected as a whole; do not
          // even propose a number obtained by silently taking the last column.
          if (duplicatePassport.length) continue;
          if (edit?.values?.passportNumber !== undefined) continue;
          if (cell.error) row.errors.push(`Паспорт: ${cell.error}`);
          const value = cleanText(cell.text);
          if (value) { if (key === 'passportSeries') series = { value, source }; else digits = { value, source }; }
        } else {
          if (edit?.values?.[key] !== undefined) continue;
          try {
            if (cell.error) throw new Error(cell.error);
            add(key, normalizeValue(key, cell, table.date1904), source);
          } catch (error) { row.errors.push(`${PERSON_FIELDS.find((f) => f.key === key)?.label}: ${(error as Error).message}`); }
        }
      }
      if (edit?.values?.passportNumber === undefined && (series || digits)) {
        if (series && !digits) row.errors.push('Серия паспорта указана без номера; дополните номер или исключите поле.');
        else if (digits) add('passportNumber', series ? `${series.value} ${digits.value}` : digits.value, digits.source);
      }
      for (const field of PERSON_FIELDS) {
        const value = edit?.values?.[field.key];
        if (value === undefined) continue;
        const source: Source = { fileName: table.fileName, table: table.name, row: rawRow.number, column: 0, raw: value };
        try {
          row.values[field.key] = [];
          add(field.key, normalizeValue(field.key, { text: value }), source);
        } catch (error) { row.errors.push(`${field.label}: ${(error as Error).message}`); }
      }
      if (['lastName', 'firstName', 'middleName'].some((key) => row.values[key as PersonFieldKey]?.some((v) => /(?:^|\s)\p{L}[.]?(?:\s|$)/u.test(v.value)))) row.warnings.push('Инициалы в ФИО требуют исправления или явной проверки.');
      if (edit?.acknowledgeWarnings) row.warnings = [];
      if (!Object.keys(row.values).length && !row.errors.length) row.errors.push('В строке нет выбранных значений. Проверьте соответствие колонок.');
      result.push(row);
    }
  }
  return result;
}
