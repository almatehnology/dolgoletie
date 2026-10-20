'use client';

import { useState } from 'react';
import { useListPeopleQuery } from '@/lib/store/people-api';
import { useListEventsQuery } from '@/lib/store/events-api';
import { useApplyArchiveActionMutation } from '@/lib/store/archive-api';
import { ArchiveTable } from '@/components/archive/archive-table';
import { formatDate, formatDateRange, fullName } from '@/lib/format';
import type { ArchiveRequest } from '@/lib/archive/model';

export default function ArchivePage() {
  const [tab, setTab] = useState<ArchiveRequest['entity']>('people');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Архив</h1>
      <div className="flex gap-2 border-b border-default-200" aria-label="Раздел архива">
        {(['people', 'events'] as const).map((entity) => (
          <button key={entity} type="button" aria-pressed={tab === entity} onClick={() => setTab(entity)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === entity ? 'border-primary text-foreground' : 'border-transparent text-default-500 hover:text-foreground'}`}>
            {entity === 'people' ? 'Люди' : 'Мероприятия'}
          </button>
        ))}
      </div>
      <ArchiveList key={tab} entity={tab} />
    </div>
  );
}

function ArchiveList({ entity }: { entity: ArchiveRequest['entity'] }) {
  const [page, setPage] = useState(1);
  const people = useListPeopleQuery({ archived: true, pageSize: 200, page }, { skip: entity !== 'people' });
  const events = useListEventsQuery({ archived: true, pageSize: 200, page }, { skip: entity !== 'events' });
  const [applyAction] = useApplyArchiveActionMutation();
  const query = entity === 'people' ? people : events;
  const items = entity === 'people'
    ? (people.currentData?.items ?? []).map((p) => ({ id: p.id, label: fullName(p), details: [p.passportNumber ?? '—', formatDate(p.deletedAt)] }))
    : (events.currentData?.items ?? []).map((e) => ({ id: e.id, label: e.title, details: [formatDateRange(e.startDate, e.endDate), e.location] }));
  return (
    <ArchiveTable key={`${entity}:${page}`} entity={entity} items={items}
      headings={entity === 'people' ? ['ФИО', 'Паспорт', 'В архиве с'] : ['Название', 'Даты', 'Место']}
      page={page} total={query.currentData?.total ?? 0} pageSize={200}
      loading={query.isFetching} loadError={!!query.error}
      onReload={() => { void query.refetch(); }} onPage={setPage}
      onAction={(request) => applyAction(request).unwrap()} />
  );
}
