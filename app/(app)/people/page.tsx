'use client';

import { Button, Spinner } from '@heroui/react';
import Link from 'next/link';
import { useState } from 'react';
import { Field } from '@/components/form-field';
import { ImportJsonButton } from '@/components/import-json-button';
import { useListPeopleQuery } from '@/lib/store/people-api';

export default function PeoplePage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const { data, isFetching } = useListPeopleQuery({ q, page, pageSize });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Люди</h1>
          <p className="text-sm text-default-500">
            Всего: {data?.total ?? 0}
            {isFetching ? <Spinner size="sm" className="ml-2 inline-block align-middle" /> : null}
          </p>
        </div>
        <div className="flex items-end gap-3">
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

      <div className="overflow-x-auto rounded-lg border border-default-200">
        <table className="w-full text-sm">
          <thead className="bg-default-50 text-left text-xs uppercase tracking-wide text-default-500">
            <tr>
              <th className="px-4 py-3">ФИО</th>
              <th className="px-4 py-3">Телефон</th>
              <th className="px-4 py-3">Паспорт</th>
              <th className="px-4 py-3 text-right">Мероприятий</th>
              <th className="px-4 py-3 text-right">Сканов</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-default-500">
                  {q ? 'По запросу ничего не найдено.' : 'Пока нет записей. Нажмите «Добавить».'}
                </td>
              </tr>
            ) : null}
            {data?.items.map((p) => (
              <tr key={p.id} className="border-t border-default-200 hover:bg-default-50">
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
          <Button size="sm" variant="ghost" isDisabled={page <= 1} onPress={() => setPage((p) => p - 1)}>
            ← Назад
          </Button>
          <span className="text-sm text-default-500">
            {page} / {totalPages}
          </span>
          <Button size="sm" variant="ghost" isDisabled={page >= totalPages} onPress={() => setPage((p) => p + 1)}>
            Вперёд →
          </Button>
        </div>
      ) : null}
    </div>
  );
}
