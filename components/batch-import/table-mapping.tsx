'use client';

import { headings, IMPORT_COLUMNS, recognizeHeader } from '@/lib/batch-import/headers';
import type { Table, TableSelection } from '@/lib/batch-import/types';

const inputClass = 'rounded-md border border-default-300 bg-white px-2 py-1.5 text-sm';
export function TableMapping({ tables, selections, onChange }: { tables: Table[]; selections: TableSelection[]; onChange: (value: TableSelection[]) => void }) {
  const update = (id: string, patch: Partial<TableSelection>) => onChange(selections.map((s) => s.tableId === id ? { ...s, ...patch } : s));
  return <div className="flex flex-col gap-5">
    <p className="text-sm text-default-600">Выберите таблицы и проверьте колонки. Неизвестные колонки остаются видимыми; «Не загружать» исключает их. Заголовок может занимать до 10 строк.</p>
    {tables.map((table) => {
      const selection = selections.find((s) => s.tableId === table.id)!;
      const labels = headings(table, selection.headerStart, selection.headerEnd);
      const range = (start: number, end: number) => {
        const safeStart = Math.max(1, start), safeEnd = Math.max(safeStart, end);
        update(table.id, { headerStart: safeStart, headerEnd: safeEnd, columns: headings(table, safeStart, safeEnd).map(recognizeHeader) });
      };
      return <section key={table.id} className="rounded-lg border border-default-200 p-4">
        <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={selection.included} onChange={(e) => update(table.id, { included: e.target.checked })} />{table.fileName} — {table.name} ({table.rows.length} строк)</label>
        {table.warnings.map((w) => <p key={w} className="text-sm text-warning">{w}</p>)}
        <div className="my-3 flex flex-wrap gap-4">
          <label className="text-sm">Начало заголовка <input aria-label={`Начало заголовка ${table.name}`} className={`${inputClass} w-20`} type="number" min={1} max={table.rows.at(-1)?.number} value={selection.headerStart} onChange={(e) => range(Number(e.target.value), selection.headerEnd)} /></label>
          <label className="text-sm">Конец заголовка <input aria-label={`Конец заголовка ${table.name}`} className={`${inputClass} w-20`} type="number" min={selection.headerStart} max={Math.min(selection.headerStart + 9, table.rows.at(-1)?.number ?? 1)} value={selection.headerEnd} onChange={(e) => range(selection.headerStart, Number(e.target.value))} /></label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm"><thead><tr><th className="p-2">Колонка исходника</th><th className="p-2">Поле карточки</th><th className="p-2">Пример значения</th></tr></thead><tbody>
            {labels.map((label, i) => <tr key={i} className="border-t border-default-200"><td className="p-2">{i + 1}. {label || 'Без заголовка'}</td><td className="p-2"><select aria-label={`Поле колонки ${i + 1} ${table.name}`} className={inputClass} value={selection.columns[i] ?? ''} onChange={(e) => update(table.id, { columns: labels.map((_, n) => n === i ? e.target.value as TableSelection['columns'][number] || null : selection.columns[n] ?? null) })}><option value="">Не загружать</option>{IMPORT_COLUMNS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></td><td className="max-w-96 break-words p-2 text-default-600">{table.rows.find((r) => r.number > selection.headerEnd && r.cells[i]?.text)?.cells[i]?.text.slice(0, 200) || '—'}</td></tr>)}
          </tbody></table>
        </div>
        <details className="mt-3 text-sm"><summary className="cursor-pointer text-primary">Первые 20 строк исходника</summary><div className="max-h-80 overflow-auto"><table className="w-full text-left"><tbody>{table.rows.slice(0, 20).map((r) => <tr key={r.number}><th className="p-2">{r.number}</th>{r.cells.map((c, i) => <td key={i} className="max-w-72 border p-2">{c.text.slice(0, 200) || (c.mergedFrom ? '(объединено)' : '—')}</td>)}</tr>)}</tbody></table></div></details>
      </section>;
    })}
  </div>;
}
