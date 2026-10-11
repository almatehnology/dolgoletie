'use client';

import { Button, Spinner } from '@heroui/react';
import Link from 'next/link';
import { useState } from 'react';
import { ExportDialog } from '@/components/export-dialog';
import { Field } from '@/components/form-field';
import { ImportJsonButton } from '@/components/import-json-button';
import { selectedOnPageCount, togglePageSelection, togglePersonSelection } from '@/lib/report-export/selection';
import { useListPeopleQuery } from '@/lib/store/people-api';

export default function PeoplePage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const pageSize = 50;
  const { currentData: data, isFetching, isError, refetch } = useListPeopleQuery({ q, page, pageSize });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const pageIds = data?.items.map((person) => person.id) ?? [];
  const pageSelectedCount = selectedOnPageCount(selectedIds, pageIds);
  const pageFullySelected = pageIds.length > 0 && pageSelectedCount === pageIds.length;

  function togglePerson(id: string) {
    setSelectedIds((current) => togglePersonSelection(current, id));
  }

  function togglePage() {
    setSelectedIds((current) => togglePageSelection(current, pageIds));
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Люди</h1>
          <p className="text-sm text-default-500">
            Всего: {data?.total ?? '—'}
            {isFetching ? <Spinner size="sm" className="ml-2 inline-block align-middle" /> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Поиск"
            value={q}
            onChange={(v) => { setQ(v); setPage(1); }}
            placeholder="Фамилия, телефон, паспорт…"
            className="w-72"
          />
          <ImportJsonButton
            endpoint="/api/people/import"
            successRedirect={(id) => `/people/${id}`}
            entityField="person"
            invalidate={['People', 'Person', 'Search']}
            label="Импорт JSON"
          />
          <Link
            href="/people/new"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            + Добавить
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-default-200 p-3">
        <p role="status" className="text-sm font-medium">Выбрано: {selectedIds.size}</p>
        <Button size="sm" variant="outline" isDisabled={isFetching || isError || pageIds.length === 0} onPress={togglePage}>
          {pageFullySelected ? 'Снять выбор на странице' : 'Выбрать страницу'} ({pageIds.length})
        </Button>
        <Button size="sm" variant="ghost" isDisabled={selectedIds.size === 0} onPress={() => setSelectedIds(new Set())}>
          Очистить выбор ({selectedIds.size})
        </Button>
        <Button size="sm" variant="primary" isDisabled={selectedIds.size === 0} onPress={() => setExportOpen(true)}>
          Экспортировать ({selectedIds.size})
        </Button>
        <p className="w-full text-xs text-default-500">
          Выбор сохраняется при поиске и переходе между страницами. Выбрано на этой странице: {pageSelectedCount} из {pageIds.length}.
          {selectedIds.size === 0 ? ' Отметьте людей для экспорта.' : ''}
        </p>
      </div>

      {isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
          <p>Не удалось загрузить список людей. Проверьте соединение и доступ к сессии.</p>
          <Button size="sm" variant="ghost" isDisabled={isFetching} onPress={() => { void refetch(); }}>Повторить</Button>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-default-200">
        <table className="w-full text-sm" aria-label="Список людей" aria-busy={isFetching}>
          <thead className="bg-default-50 text-left text-xs uppercase tracking-wide text-default-500">
            <tr>
              <th scope="col" className="px-4 py-3">Выбор</th>
              <th className="px-4 py-3">ФИО</th>
              <th className="px-4 py-3">Телефон</th>
              <th className="px-4 py-3">Паспорт</th>
              <th className="px-4 py-3 text-right">Мероприятия</th>
              <th className="px-4 py-3 text-right">Документы</th>
            </tr>
          </thead>
          <tbody>
            {isFetching && !data ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-default-500">Загрузка списка…</td></tr>
            ) : null}
            {!isError && data?.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-default-500">
                  {q ? 'По запросу ничего не найдено.' : 'Пока нет записей. Нажмите «Добавить».'}
                </td>
              </tr>
            ) : null}
            {data?.items.map((p) => (
              <tr key={p.id} className="border-t border-default-200 hover:bg-default-50">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    aria-label={`Выбрать ${[p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ')}`}
                    checked={selectedIds.has(p.id)}
                    disabled={isFetching || isError}
                    onChange={() => togglePerson(p.id)}
                  />
                </td>
                <td className="px-4 py-3">
                  <Link href={`/people/${p.id}`} className="text-primary hover:underline">
                    {p.lastName} {p.firstName} {p.middleName ?? ''}
                  </Link>
                </td>
                <td className="px-4 py-3 text-default-600">{p.phone ?? '—'}</td>
                <td className="px-4 py-3 text-default-600">{p.passportNumber ?? '—'}</td>
                <td className="px-4 py-3 text-right">{p._count.participations}</td>
                <td className="px-4 py-3 text-right">{p._count.scans}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" isDisabled={isFetching || page <= 1} onPress={() => setPage((p) => p - 1)}>
            ← Назад
          </Button>
          <span className="text-sm text-default-500">
            {page} / {totalPages}
          </span>
          <Button size="sm" variant="ghost" isDisabled={isFetching || page >= totalPages} onPress={() => setPage((p) => p + 1)}>
            Вперёд →
          </Button>
        </div>
      ) : null}
      <ExportDialog
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        context="people"
        personIds={[...selectedIds]}
      />
    </div>
  );
}
