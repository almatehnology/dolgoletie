'use client';

import { Button } from '@heroui/react';
import Link from 'next/link';
import { useState } from 'react';
import { useListPeopleQuery, useRestorePersonMutation } from '@/lib/store/people-api';
import { useListEventsQuery, useRestoreEventMutation } from '@/lib/store/events-api';
import { formatDateRange, fullName } from '@/lib/format';

export default function ArchivePage() {
  const [tab, setTab] = useState<'people' | 'events'>('people');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Архив</h1>
      <div className="flex gap-2 border-b border-default-200">
        <TabButton active={tab === 'people'} onClick={() => setTab('people')}>
          Люди
        </TabButton>
        <TabButton active={tab === 'events'} onClick={() => setTab('events')}>
          Мероприятия
        </TabButton>
      </div>
      {tab === 'people' ? <ArchivedPeople /> : <ArchivedEvents />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        '-mb-px border-b-2 px-3 py-2 text-sm',
        active ? 'border-primary text-foreground' : 'border-transparent text-default-500 hover:text-foreground',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function ArchivedPeople() {
  const { data } = useListPeopleQuery({ archived: true, pageSize: 200 });
  const [restore] = useRestorePersonMutation();
  if (!data || data.items.length === 0) {
    return <p className="text-sm text-default-500">Архив пуст.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-default-200">
      <table className="w-full text-sm">
        <thead className="bg-default-50 text-left text-xs uppercase text-default-500">
          <tr>
            <th className="px-3 py-2">ФИО</th>
            <th className="px-3 py-2">Паспорт</th>
            <th className="px-3 py-2">В архиве с</th>
            <th className="px-3 py-2 text-right">Действия</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((p) => (
            <tr key={p.id} className="border-t border-default-200">
              <td className="px-3 py-2">
                <Link href={`/people/${p.id}`} className="text-primary hover:underline">{fullName(p)}</Link>
              </td>
              <td className="px-3 py-2 text-default-600">{p.passportNumber ?? '—'}</td>
              <td className="px-3 py-2 text-default-600">
                {p.deletedAt ? new Date(p.deletedAt).toLocaleDateString('ru-RU') : '—'}
              </td>
              <td className="px-3 py-2 text-right">
                <Button size="sm" variant="primary" onPress={() => restore(p.id)}>
                  Восстановить
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArchivedEvents() {
  const { data } = useListEventsQuery({ archived: true, pageSize: 200 });
  const [restore] = useRestoreEventMutation();
  if (!data || data.items.length === 0) {
    return <p className="text-sm text-default-500">Архив пуст.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-default-200">
      <table className="w-full text-sm">
        <thead className="bg-default-50 text-left text-xs uppercase text-default-500">
          <tr>
            <th className="px-3 py-2">Название</th>
            <th className="px-3 py-2">Даты</th>
            <th className="px-3 py-2">Место</th>
            <th className="px-3 py-2 text-right">Действия</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((e) => (
            <tr key={e.id} className="border-t border-default-200">
              <td className="px-3 py-2">
                <Link href={`/events/${e.id}`} className="text-primary hover:underline">{e.title}</Link>
              </td>
              <td className="px-3 py-2 text-default-600">{formatDateRange(e.startDate, e.endDate)}</td>
              <td className="px-3 py-2 text-default-600">{e.location}</td>
              <td className="px-3 py-2 text-right">
                <Button size="sm" variant="primary" onPress={() => restore(e.id)}>
                  Восстановить
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
