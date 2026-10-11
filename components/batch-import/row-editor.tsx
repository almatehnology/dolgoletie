'use client';

import { useState } from 'react';
import { PERSON_FIELDS, type PersonFieldKey } from '@/lib/person-fields';
import type { ImportRow, RowEdit, Values } from '@/lib/batch-import/types';

export function RowEditor({ row, initial, onSave, mergeOptions }: { row: ImportRow; initial?: RowEdit; onSave: (edit: RowEdit) => void; mergeOptions: { rowId: string; label: string }[] }) {
  const [values, setValues] = useState<Values>(Object.fromEntries(PERSON_FIELDS.map((f) => [f.key, initial?.values?.[f.key] ?? row.values[f.key]?.[0]?.value ?? ''])));
  const [dirtyFields, setDirtyFields] = useState<Set<PersonFieldKey>>(() => new Set());
  const [acknowledgeWarnings, setAck] = useState(initial?.acknowledgeWarnings ?? false);
  const [separate, setSeparate] = useState(initial?.separate ?? false);
  const [excluded, setExcluded] = useState(initial?.excluded ?? row.excluded);
  const [mergeWith, setMergeWith] = useState(initial?.mergeWith ?? '');
  return <div className="mt-3 rounded-md border border-default-200 bg-default-50 p-4">
    <p className="mb-3 text-sm">{row.sources[0]?.fileName} — {row.sources[0]?.table}, строка {row.sources[0]?.row}. Пустое исправление исключает это значение из импорта.</p>
    <details className="mb-3 text-sm"><summary>Исходные ячейки</summary>{row.sources.map((s, i) => <p key={i} className="break-words">Колонка {s.column || 'исправлено'}: {s.raw || '—'}</p>)}</details>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{PERSON_FIELDS.map((f) => <label key={f.key} className="flex flex-col gap-1 text-sm">{f.label}<input className="rounded-md border border-default-300 bg-white p-2" value={values[f.key] ?? ''} placeholder={f.type === 'date' ? 'ГГГГ-ММ-ДД' : f.type === 'gender' ? 'Мужской / женский / иное' : ''} onChange={(e) => { setValues({ ...values, [f.key]: e.target.value }); setDirtyFields((previous) => new Set([...previous, f.key])); }} />{new Set(row.values[f.key]?.map((v) => v.value)).size > 1 && <span className="text-xs text-danger">Несколько исходных значений. Они останутся конфликтом, пока вы явно не исправите это поле или не выберете значение в плане.</span>}</label>)}</div>
    <div className="mt-4 flex flex-col gap-2 text-sm">
      <label><input type="checkbox" checked={acknowledgeWarnings} onChange={(e) => setAck(e.target.checked)} /> Я проверил(а) ФИО, числовые номера и предупреждения этой строки</label>
      <label><input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} /> Рассматривать как отдельного человека в пакете</label>
      <label><input type="checkbox" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} /> Исключить эту строку</label>
      <label className="flex flex-col gap-1">Объединить строки одного человека вручную<select className="rounded-md border p-2" value={mergeWith} onChange={(e) => setMergeWith(e.target.value)}><option value="">Использовать сопоставление пакета</option>{mergeOptions.filter((option) => option.rowId !== row.id).map((option) => <option key={option.rowId} value={option.rowId}>{option.label}</option>)}</select></label>
    </div>
    <button type="button" className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={() => onSave({ rowId: row.id, values: { ...initial?.values, ...Object.fromEntries([...dirtyFields].map((key) => [key, values[key] ?? ''])) }, acknowledgeWarnings, separate, excluded, mergeWith: mergeWith || null })}>Пересчитать с исправлениями</button>
  </div>;
}
