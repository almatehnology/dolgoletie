'use client';

import { Modal } from '@heroui/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/lib/store/hooks';
import { closeSearchModal, openSearchModal } from '@/lib/store/ui-slice';
import { useSearchQuery } from '@/lib/store/search-api';
import { formatDateRange, fullName } from '@/lib/format';
import { FullScreenModal } from '@/components/full-screen-modal';

function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SearchModal() {
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.ui.searchModalOpen);
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q, 200);
  const { data, isFetching } = useSearchQuery(
    { q: debouncedQ, scope: 'all' },
    { skip: !open || debouncedQ.length < 1 },
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dispatch(openSearchModal());
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  return (
    <FullScreenModal isOpen={open} onOpenChange={(v) => !v && dispatch(closeSearchModal())}>
      <Modal.Header className="flex items-center justify-between border-b border-default-200 px-6 py-4">
        <Modal.Heading className="text-base font-semibold">Поиск</Modal.Heading>
        <Modal.CloseTrigger />
      </Modal.Header>
      <Modal.Body className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <input
          autoFocus
          placeholder="ФИО, паспорт, название мероприятия…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          className="h-11 w-full rounded-md border border-default-300 bg-white px-4 text-base text-foreground shadow-sm transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <div className="flex-1 overflow-auto">
          {debouncedQ.length < 1 ? (
            <p className="text-sm text-default-500">Введите запрос для поиска.</p>
          ) : isFetching ? (
            <p className="text-sm text-default-500">Ищу…</p>
          ) : (
            <Results
              people={data?.people ?? []}
              events={data?.events ?? []}
              onNavigate={() => dispatch(closeSearchModal())}
            />
          )}
        </div>
      </Modal.Body>
    </FullScreenModal>
  );
}

type AnyPerson = { id: string; lastName: string; firstName: string; middleName: string | null; phone: string | null; passportNumber: string | null };
type AnyEvent = { id: string; title: string; startDate: string; endDate: string; location: string };

function Results({ people, events, onNavigate }: { people: AnyPerson[]; events: AnyEvent[]; onNavigate: () => void }) {
  if (people.length === 0 && events.length === 0) {
    return <p className="text-sm text-default-500">Ничего не найдено.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {people.length > 0 ? (
        <section>
          <h3 className="mb-1 text-xs uppercase text-default-500">Люди</h3>
          <ul className="divide-y divide-default-200 rounded-lg border border-default-200 bg-white">
            {people.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/people/${p.id}`}
                  onClick={onNavigate}
                  className="flex flex-col px-3 py-2 hover:bg-default-50"
                >
                  <span className="font-medium">{fullName(p)}</span>
                  <span className="text-xs text-default-500">
                    {p.phone ?? '—'} · {p.passportNumber ?? 'паспорт не указан'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {events.length > 0 ? (
        <section>
          <h3 className="mb-1 text-xs uppercase text-default-500">Мероприятия</h3>
          <ul className="divide-y divide-default-200 rounded-lg border border-default-200 bg-white">
            {events.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/events/${e.id}`}
                  onClick={onNavigate}
                  className="flex flex-col px-3 py-2 hover:bg-default-50"
                >
                  <span className="font-medium">{e.title}</span>
                  <span className="text-xs text-default-500">
                    {formatDateRange(e.startDate, e.endDate)} · {e.location}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
