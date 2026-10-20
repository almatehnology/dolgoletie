'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { ArchiveRequest, ArchiveResult } from '@/lib/archive/model';

export interface ArchiveTableProps {
  entity: ArchiveRequest['entity'];
  items: { id: string; label: string; details: string[] }[];
  headings: string[];
  page: number;
  pageSize: number;
  total: number;
  loading: boolean;
  loadError: boolean;
  onReload(): void;
  onPage(page: number): void;
  onAction(request: ArchiveRequest): Promise<ArchiveResult>;
}

const button = 'rounded-md border border-default-300 px-3 py-2 text-sm disabled:opacity-50';

export function ArchiveTable(props: ArchiveTableProps) {
  const { entity, items, headings, page, pageSize, total, loading, loadError, onReload, onPage, onAction } = props;
  const [selected, setSelected] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const visible = items.filter((item) => !removed.includes(item.id));
  const ids = selected.filter((id) => visible.some((item) => item.id === id));
  const disabled = busy || loading || loadError;
  const all = visible.length > 0 && ids.length === visible.length;

  async function act(action: ArchiveRequest['action'], targets: string[]) {
    if (disabled || inFlight.current || !targets.length) return;
    const names = visible.filter((item) => targets.includes(item.id)).map((item) => item.label);
    const summary = `${names.slice(0, 5).join('\n')}${names.length > 5 ? '\n…' : ''}`;
    const message = action === 'restore'
      ? `Восстановить выбранные записи (${targets.length})?\n${summary}`
      : `Удалить навсегда выбранные записи (${targets.length})?\n${summary}\nСвязанные записи участия${entity === 'people' ? ' и сканы' : ' и экскурсии'} будут удалены из приложения. Восстановление из архива станет недоступно. История и оригиналы вложений сохраняются для синхронизации; это не безопасное стирание данных.`;
    if (!window.confirm(message)) return;
    inFlight.current = true;
    setBusy(true); setFeedback(''); setError('');
    try {
      const result = await onAction({ entity, action, ids: targets, confirm: true });
      setRemoved((previous) => [...previous, ...targets]);
      setSelected((previous) => previous.filter((id) => !targets.includes(id)));
      setFeedback(`${action === 'restore' ? 'Восстановлено' : 'Удалено'} записей: ${result.count}.`);
    } catch (cause) {
      const message = (cause as { data?: { error?: { message?: string } } })?.data?.error?.message;
      setError(message ?? 'Не удалось выполнить операцию. Обновите архив перед повтором.');
    } finally {
      inFlight.current = false; setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-label={entity === 'people' ? 'Люди в архиве' : 'Мероприятия в архиве'} aria-busy={busy || loading}>
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className="text-sm">Выбрано: {ids.length}</span>
        <button type="button" className={button} disabled={disabled || !ids.length} onClick={() => act('restore', ids)}>Восстановить выбранные</button>
        <button type="button" className={`${button} text-danger`} disabled={disabled || !ids.length} onClick={() => act('delete', ids)}>Удалить выбранные навсегда</button>
        <button type="button" className={button} disabled={busy || loading} onClick={onReload}>Обновить</button>
      </div>
      {feedback && <p role="status" className="text-sm text-success">{feedback}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {loadError && <p role="alert" className="text-sm text-danger">Не удалось загрузить архив. Обновите страницу архива.</p>}
      {loading && <p role="status" className="text-sm text-default-500">Загрузка архива…</p>}
      {!loading && !loadError && !visible.length && <p className="text-sm text-default-500">{page === 1 ? 'Архив пуст.' : 'На этой странице записей нет. Перейдите на предыдущую страницу.'}</p>}
      {visible.length > 0 && <div className="overflow-x-auto rounded-lg border border-default-200">
        <table className="w-full text-sm">
          <thead className="bg-default-50 text-left text-xs uppercase text-default-500"><tr>
            <th className="px-3 py-2"><input type="checkbox" aria-label="Выбрать все записи на странице" checked={all}
              ref={(node) => { if (node) node.indeterminate = ids.length > 0 && !all; }} disabled={disabled}
              onChange={(e) => setSelected(e.target.checked ? visible.map((item) => item.id) : [])} /></th>
            {headings.map((heading) => <th key={heading} className="px-3 py-2">{heading}</th>)}
            <th className="px-3 py-2 text-right">Действия</th>
          </tr></thead>
          <tbody>{visible.map((item) => <tr key={item.id} aria-selected={ids.includes(item.id)} className={`border-t border-default-200 ${ids.includes(item.id) ? 'bg-primary/10' : ''}`}>
            <td className="px-3 py-2"><input type="checkbox" aria-label={`Выбрать: ${item.label}`} checked={ids.includes(item.id)} disabled={disabled}
              onChange={(e) => setSelected(e.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} /></td>
            <td className="px-3 py-2"><Link href={`/${entity}/${item.id}`} className="text-primary hover:underline">{item.label}</Link></td>
            {item.details.map((detail, index) => <td key={index} className="px-3 py-2 text-default-600">{detail}</td>)}
            <td className="px-3 py-2"><div className="flex justify-end gap-2">
              <button type="button" className={button} disabled={disabled} aria-label={`Восстановить: ${item.label}`} onClick={() => act('restore', [item.id])}>Восстановить</button>
              <button type="button" className={`${button} text-danger`} disabled={disabled} aria-label={`Удалить навсегда: ${item.label}`} onClick={() => act('delete', [item.id])}>Удалить навсегда</button>
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>}
      <div className="flex items-center gap-3" aria-label="Страницы архива">
        <button type="button" className={button} disabled={busy || loading || page <= 1} onClick={() => onPage(page - 1)}>Назад</button>
        <span className="text-sm">Страница {page} · всего записей: {total}</span>
        <button type="button" className={button} disabled={disabled || page * pageSize >= total} onClick={() => onPage(page + 1)}>Далее</button>
      </div>
    </section>
  );
}
