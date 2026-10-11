'use client';

import { useMemo, useState } from 'react';
import { PERSON_FIELDS } from '@/lib/person-fields';
import { extractRows } from '@/lib/batch-import/rows';
import type { Decision, JobView, PersonSnapshot, PlanGroup, RowEdit } from '@/lib/batch-import/types';
import { RowEditor } from './row-editor';

export const STATUS_LABELS: Record<PlanGroup['status'], string> = { new: 'Новые', addition: 'Дополнения', same: 'Совпадения', conflict: 'Конфликты', error: 'Ошибки', skipped: 'Пропущенные' };
export const personName = (p: PersonSnapshot) => [p.values.lastName, p.values.firstName, p.values.middleName].filter(Boolean).join(' ');
type Props = {
  job: JobView;
  decisions: Decision[];
  onDecision: (decision: Decision) => void;
  onRow: (edit: RowEdit) => void;
  onManualCandidate: (groupId: string, person: PersonSnapshot) => Promise<void>;
};
export function ImportPreview({ job, decisions, onDecision, onRow, onManualCandidate }: Props) {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const rows = useMemo(() => new Map(extractRows(job.tables, job.rowEdits).map((r) => [r.id, r])), [job]);
  const groups = job.plan?.groups.filter((g) => filter === 'all' || g.status === filter) ?? [];
  return <div className="flex flex-col gap-4">
    <label className="text-sm">Показать <select className="ml-2 rounded-md border p-2" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }}><option value="all">Все ({job.plan?.groups.length})</option>{Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label} ({job.plan?.summary[key as PlanGroup['status']]})</option>)}</select></label>
    {groups.slice(page * 25, page * 25 + 25).map((group) => <GroupPreview key={`${group.id}:${job.revision}`} group={group} decision={decisions.find((d) => d.groupId === group.id)} onDecision={onDecision} onManualCandidate={(person) => onManualCandidate(group.id, person)} jobId={job.id}>
      <SourceEditor group={group} job={job} rows={rows} onRow={onRow} />
    </GroupPreview>)}
    {groups.length > 25 && <div className="flex items-center justify-end gap-3 text-sm"><button disabled={page === 0} onClick={() => setPage(page - 1)}>← Назад</button><span>{page + 1} / {Math.ceil(groups.length / 25)}</span><button disabled={(page + 1) * 25 >= groups.length} onClick={() => setPage(page + 1)}>Вперёд →</button></div>}
  </div>;
}
function SourceEditor({ group, job, rows, onRow }: { group: PlanGroup; job: JobView; rows: Map<string, ReturnType<typeof extractRows>[number]>; onRow: Props['onRow'] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(group.rowIds[0]);
  const mergeOptions = job.plan!.groups.map((g) => ({ rowId: g.rowIds[0], label: `${[g.values.lastName, g.values.firstName, g.values.middleName].filter(Boolean).join(' ') || 'Без ФИО'} — ${g.sources[0]?.fileName}, строка ${g.sources[0]?.row}` }));
  return <details className="mt-4" onToggle={(e) => setOpen(e.currentTarget.open)}><summary className="cursor-pointer text-sm text-primary">Источники и исправление строк ({group.rowIds.length})</summary>{open && <>
    <label className="mt-2 block text-sm">Исходная строка<select className="ml-2 max-w-full rounded-md border p-2" value={selected} onChange={(e) => setSelected(e.target.value)}>{group.rowIds.map((id) => { const row = rows.get(id); return <option key={id} value={id}>{row?.sources[0]?.fileName} / {row?.sources[0]?.table}, строка {row?.sources[0]?.row}</option>; })}</select></label>
    {rows.has(selected) && <RowEditor key={selected} row={rows.get(selected)!} initial={job.rowEdits.find((e) => e.rowId === selected)} onSave={onRow} mergeOptions={mergeOptions} />}
  </>}</details>;
}
function GroupPreview({ group, decision, onDecision, onManualCandidate, jobId, children }: { group: PlanGroup; decision?: Decision; onDecision: Props['onDecision']; onManualCandidate: (person: PersonSnapshot) => Promise<void>; jobId: string; children: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [manual, setManual] = useState<PersonSnapshot[]>([]);
  const [error, setError] = useState('');
  const patch = (change: Partial<Decision>) => onDecision({ groupId: group.id, action: 'auto', ...decision, ...change });
  const selected = decision?.action === 'existing' ? decision.personId : decision?.action === 'new' ? 'new' : decision?.action === 'skip' ? 'skip' : 'auto';
  async function search() {
    setSearching(true); setError('');
    try {
      const response = await fetch(`/api/batch-import/jobs/${jobId}/candidates?q=${encodeURIComponent(query)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Не удалось найти кандидатов.');
      setManual(data.items); if (data.hasMore) setError('Найдено более 50 карточек. Уточните запрос.');
    } catch (err) { setError((err as Error).message); } finally { setSearching(false); }
  }
  return <section className="rounded-lg border border-default-200 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><h3 className="font-medium">{[group.values.lastName, group.values.firstName, group.values.middleName].filter(Boolean).join(' ') || 'Без ФИО'}</h3><span className={group.ready ? 'text-sm text-success' : 'text-sm text-danger'}>{STATUS_LABELS[group.status]}</span></div>
    <p className="mt-1 text-xs text-default-500">{[...new Set(group.sources.map((s) => `${s.fileName} / ${s.table}, строка ${s.row}`))].join('; ')}</p>
    {[...group.errors, ...group.warnings].map((w, i) => <p role="status" key={i} className="mt-2 text-sm text-danger">{w}</p>)}
    <label className="mt-3 flex flex-col gap-1 text-sm">Решение по человеку<select className="rounded-md border border-default-300 bg-white p-2" value={selected ?? 'auto'} onChange={(e) => e.target.value === 'auto' || e.target.value === 'new' || e.target.value === 'skip' ? patch({ action: e.target.value, personId: undefined, restore: false }) : patch({ action: 'existing', personId: e.target.value, restore: false, fields: undefined })}>
      <option value="auto">Предложение: {group.target ? personName(group.target) : group.action === 'new' ? 'новая карточка' : 'выбор требуется'}</option><option value="new">Создать отдельного человека</option><option value="skip">Пропустить группу</option>
      {group.candidates.map((c) => <option key={c.id} value={c.id}>{personName(c)} · {c.values.birthDate ?? 'без даты рождения'} · {c.values.passportNumber ?? 'без паспорта'}{c.deletedAt ? ' · АРХИВ' : ''} — {c.reasons.join(', ')}</option>)}
      {decision?.personId && !group.candidates.some((c) => c.id === decision.personId) && <option value={decision.personId}>Выбранный вручную кандидат — пересчитайте план</option>}
    </select></label>
    {group.target?.deletedAt && <label className="mt-2 block text-sm"><input type="checkbox" checked={decision?.restore ?? false} onChange={(e) => patch({ action: 'existing', personId: group.target!.id, restore: e.target.checked })} /> Восстановить из архива после подтверждения. Без отметки карточка останется в архиве.</label>}
    <details className="mt-3 text-sm"><summary className="cursor-pointer text-primary">Найти другую карточку, включая архив</summary><div className="my-2 flex gap-2"><input aria-label="Поиск кандидата" className="min-w-0 flex-1 rounded-md border p-2" placeholder="ФИО, дата рождения, телефон, паспорт" value={query} onChange={(e) => setQuery(e.target.value)} /><button type="button" disabled={query.length < 2 || searching} onClick={search}>Найти</button></div>{error && <p className="text-danger">{error}</p>}{manual.map((p) => <button type="button" key={p.id} className="my-1 block w-full rounded-md border p-2 text-left" onClick={() => onManualCandidate(p).catch((err) => setError(err.message))}>{personName(p)} · {p.values.birthDate ?? '—'} · {p.values.passportNumber ?? '—'}{p.deletedAt ? ' · АРХИВ' : ''}</button>)}</details>
    <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Поле</th><th className="p-2">В карточке</th><th className="p-2">Из источников</th><th className="p-2">Итог / решение</th></tr></thead><tbody>{group.changes.filter((c) => c.current || c.incoming.length || !c.resolved).map((c) => {
      const chosen = decision?.fields?.[c.key];
      return <tr key={c.key} className="border-t border-default-200"><td className="p-2 align-top">{PERSON_FIELDS.find((f) => f.key === c.key)?.label}{!c.resolved && <span className="block text-danger">Конфликт</span>}</td><td className="max-w-60 break-words p-2 align-top">{c.current ?? '—'}</td><td className="max-w-80 p-2 align-top">{c.incoming.slice(0, 10).map((v, i) => <div key={i} className="mb-2 break-words">{v.value}<span className="block text-xs text-default-500">{v.source.fileName}, {v.source.table}, строка {v.source.row}, колонка {v.source.column || 'исправлено'}</span></div>)}{c.incoming.length > 10 && <p className="text-xs text-default-500">Ещё {c.incoming.length - 10} значений — см. выбор исходной строки ниже.</p>}</td><td className="min-w-64 p-2 align-top">
        <select aria-label={`Выбор ${c.key}`} className="w-full rounded-md border p-2" value={chosen === null ? 'keep' : chosen === undefined ? 'auto' : 'custom'} onChange={(e) => {
          const fields = { ...decision?.fields };
          if (e.target.value === 'auto') delete fields[c.key]; else if (e.target.value === 'keep') fields[c.key] = null; else fields[c.key] = c.value ?? c.incoming[0]?.value ?? '';
          patch({ fields });
        }}><option value="auto">{c.resolved ? 'Предложенное значение' : 'Нужно выбрать'}</option><option value="keep">{c.current ? 'Оставить значение карточки' : 'Не добавлять поле'}</option><option value="custom">Взять или исправить значение</option></select>
        {chosen !== null && <input aria-label={`Итог ${c.key}`} className="mt-2 w-full rounded-md border p-2" value={chosen ?? c.value ?? ''} onChange={(e) => patch({ fields: { ...decision?.fields, [c.key]: e.target.value } })} />}
        {c.incoming.length > 1 && <div className="mt-1 flex flex-wrap gap-1">{[...new Set(c.incoming.map((v) => v.value))].map((value) => <button type="button" key={value} className="rounded border px-2 py-1 text-xs" onClick={() => patch({ fields: { ...decision?.fields, [c.key]: value } })}>Выбрать {value}</button>)}</div>}
      </td></tr>;
    })}</tbody></table></div>
    {children}
  </section>;
}
