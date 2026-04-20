'use client';

import { Button, Spinner } from '@heroui/react';
import Link from 'next/link';
import { useState } from 'react';
import { DatePickerField } from '@/components/date-picker-field';
import { Field } from '@/components/form-field';
import { ImportJsonButton } from '@/components/import-json-button';
import { useListEventsQuery } from '@/lib/store/events-api';
import { formatDateRange, formatMoney } from '@/lib/format';

export default function EventsPage() {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const { data, isFetching } = useListEventsQuery({ q, from: from || undefined, to: to || undefined, page, pageSize });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Мероприятия</h1>
          <p className="text-sm text-default-500">
            Всего: {data?.total ?? 0}
            {isFetching ? <Spinner size="sm" className="ml-2 inline-block align-middle" /> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Поиск"
            value={q}
            onChange={(v) => { setQ(v); setPage(1); }}
            placeholder="Название, место, программа…"
            className="w-60"
          />
          <DatePickerField
            label="С"
            value={from}
            onChange={(v) => { setFrom(v); setPage(1); }}
            className="w-40"
          />
          <DatePickerField
            label="По"
            value={to}
            onChange={(v) => { setTo(v); setPage(1); }}
            className="w-40"
            minValue={from || undefined}
          />
          <ImportJsonButton
            endpoint="/api/events/import"
            successRedirect={(id) => `/events/${id}`}
            entityField="event"
            invalidate={['Events', 'Event', 'Search']}
            label="Импорт JSON"
          />
          <Link
            href="/events/new"
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
              <th className="px-4 py-3">Название</th>
              <th className="px-4 py-3">Даты</th>
              <th className="px-4 py-3">Место</th>
              <th className="px-4 py-3 text-right">Стоимость</th>
              <th className="px-4 py-3 text-right">Участников</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-default-500">
                  {q || from || to ? 'По фильтру ничего не найдено.' : 'Пока нет мероприятий.'}
                </td>
              </tr>
            ) : null}
            {data?.items.map((e) => (
              <tr key={e.id} className="border-t border-default-200 hover:bg-default-50">
                <td className="px-4 py-3">
                  <Link href={`/events/${e.id}`} className="text-primary hover:underline">
                    {e.title}
                  </Link>
                  {e.isOutbound ? <span className="ml-2 text-xs text-default-500">выездное</span> : null}
                </td>
                <td className="px-4 py-3 text-default-600">{formatDateRange(e.startDate, e.endDate)}</td>
                <td className="px-4 py-3 text-default-600">{e.location}</td>
                <td className="px-4 py-3 text-right">{formatMoney(e.cost, e.currency)}</td>
                <td className="px-4 py-3 text-right">{e._count.participations}</td>
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
