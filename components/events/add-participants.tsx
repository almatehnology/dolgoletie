'use client';

import { Button, Modal } from '@heroui/react';
import { useRef, useState } from 'react';
import { Field } from '@/components/form-field';
import { FullScreenModal } from '@/components/full-screen-modal';
import { api } from '@/lib/store/api';
import type { ParticipationInput, ParticipationWithPerson, PaymentStatus } from '@/lib/store/events-api';
import { useListPeopleQuery, type PersonListItem } from '@/lib/store/people-api';
import { formatDate, fullName } from '@/lib/format';

const MAX_PARTICIPANTS = 200;

// Keep the existing single-person mutation and its callers unchanged.
const participantsApi = api.injectEndpoints({
  endpoints: (b) => ({
    addParticipants: b.mutation<
      { items: ParticipationWithPerson[]; count: number },
      { eventId: string; input: Omit<ParticipationInput, 'personId'> & { personIds: string[] } }
    >({
      query: ({ eventId, input }) => ({ url: `events/${eventId}/participants`, method: 'POST', body: input }),
      invalidatesTags: (_r, _e, { eventId, input }) => [
        { type: 'Event', id: eventId },
        { type: 'Events', id: 'LIST' },
        { type: 'People', id: 'LIST' },
        ...input.personIds.map((id) => ({ type: 'Person' as const, id })),
      ],
    }),
  }),
});

export function AddParticipants({
  eventId,
  existingPersonIds,
  onClose,
}: {
  eventId: string;
  existingPersonIds: string[];
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PersonListItem[]>([]);
  const [status, setStatus] = useState<PaymentStatus>('UNPAID');
  const [prepaid, setPrepaid] = useState('');
  const [totalDue, setTotalDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const { currentData: data, isFetching, isError, refetch } = useListPeopleQuery({ q, page, pageSize: 20 });
  const [addParticipants, { isLoading }] = participantsApi.useAddParticipantsMutation();
  const existing = new Set(existingPersonIds);
  const available = data?.items.filter((person) => !existing.has(person.id)) ?? [];
  const chosen = selected.filter((person) => !existing.has(person.id));
  const selectedIds = new Set(chosen.map((person) => person.id));

  function toggle(person: PersonListItem) {
    setSelected((previous) => {
      const current = previous.filter((item) => !existing.has(item.id));
      if (current.some((item) => item.id === person.id)) return current.filter((item) => item.id !== person.id);
      return current.length < MAX_PARTICIPANTS ? [...current, person] : current;
    });
  }

  async function submit() {
    if (chosen.length === 0 || submitting.current) return;
    submitting.current = true;
    setError(null);
    try {
      await addParticipants({
        eventId,
        input: {
          personIds: chosen.map((person) => person.id),
          paymentStatus: status,
          prepaidAmount: prepaid.trim() || undefined,
          totalDue: totalDue.trim() || undefined,
        },
      }).unwrap();
      onClose();
    } catch (err) {
      const e = err as { data?: { error?: { message?: string } } };
      setError(e.data?.error?.message ?? 'Не удалось добавить участников. Проверьте список участников перед повторной попыткой.');
    } finally {
      submitting.current = false;
    }
  }

  return (
    <FullScreenModal isOpen onOpenChange={(open) => { if (!open && !submitting.current) onClose(); }}>
      <Modal.Header className="flex items-center justify-between border-b border-default-200 px-6 py-4">
        <Modal.Heading className="text-base font-semibold">Добавить участников</Modal.Heading>
        <Modal.CloseTrigger isDisabled={isLoading} />
      </Modal.Header>
      <Modal.Body className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <fieldset disabled={isLoading} className="flex min-w-0 flex-col gap-4">
          <Field label="Поиск человека" value={q} onChange={(value) => { setQ(value); setPage(1); }} placeholder="Фамилия, телефон, паспорт…" />
          <p className="text-sm text-default-500">Отметьте до 200 человек для добавления. Текущие участники скрыты. Выбор сохраняется при поиске и смене страницы.</p>
          <div className="overflow-hidden rounded-lg border border-default-200 bg-white" aria-busy={isFetching}>
            <div className="max-h-[calc(5*6.5rem)] overflow-y-auto">
              {isFetching ? <p className="p-3 text-sm text-default-500" role="status">Загрузка…</p> : null}
              {isError ? (
                <div className="p-3" role="alert">
                  <p className="text-sm text-danger">Не удалось загрузить список людей.</p>
                  <Button variant="ghost" onPress={() => refetch()}>Повторить</Button>
                </div>
              ) : null}
              {!isFetching && !isError && available.length === 0 ? (
                <p className="p-3 text-sm text-default-500">
                  {data?.items.length ? 'На этой странице все уже участвуют. Измените поиск или перейдите на другую страницу.' : 'Никого не найдено.'}
                </p>
              ) : null}
              {available.map((person) => (
                <PersonResultCard
                  key={person.id}
                  person={person}
                  selected={selectedIds.has(person.id)}
                  disabled={isLoading || (chosen.length >= MAX_PARTICIPANTS && !selectedIds.has(person.id))}
                  onSelect={() => toggle(person)}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" isDisabled={page === 1 || isFetching || isLoading} onPress={() => setPage((value) => value - 1)}>Назад</Button>
            <span className="text-sm">Страница {page}{data ? ` из ${Math.max(1, Math.ceil(data.total / data.pageSize))}` : ''}</span>
            <Button variant="outline" isDisabled={!data || page * data.pageSize >= data.total || isFetching || isLoading} onPress={() => setPage((value) => value + 1)}>Далее</Button>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium" role="status">Выбрано: {chosen.length}</p>
            <div className="flex flex-wrap gap-2">
              {chosen.map((person) => (
                <Button key={person.id} size="sm" variant="outline" isDisabled={isLoading} aria-label={`Убрать из выбора: ${fullName(person)}`} onPress={() => toggle(person)}>
                  {fullName(person)} ×
                </Button>
              ))}
            </div>
          </div>
          <p className="text-sm text-default-500">Статус оплаты и суммы ниже применяются к каждому выбранному участнику.</p>
          <div>
            <div className="mb-2 text-sm font-medium">Статус оплаты</div>
            <div className="grid grid-cols-3 gap-2">
              {(['UNPAID', 'PREPAID', 'PAID'] as PaymentStatus[]).map((value) => (
                <Button key={value} type="button" size="sm" isDisabled={isLoading} variant={status === value ? 'primary' : 'outline'} onPress={() => setStatus(value)}>
                  {value === 'UNPAID' ? 'Не оплачено' : value === 'PREPAID' ? 'Предоплата' : 'Оплачено'}
                </Button>
              ))}
            </div>
          </div>
          <Field label="Предоплата" value={prepaid} onChange={setPrepaid} placeholder="0.00" inputMode="decimal" />
          <Field label="Итого" value={totalDue} onChange={setTotalDue} placeholder="0.00" inputMode="decimal" />
        </fieldset>
        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      </Modal.Body>
      <Modal.Footer className="flex justify-end gap-2 border-t border-default-200 px-6 py-4">
        <Button variant="ghost" isDisabled={isLoading} onPress={onClose}>Отмена</Button>
        <Button variant="primary" isDisabled={chosen.length === 0 || isLoading} onPress={submit}>
          {isLoading ? 'Добавление…' : `Добавить выбранных (${chosen.length})`}
        </Button>
      </Modal.Footer>
    </FullScreenModal>
  );
}

function PersonResultCard({ person, selected, disabled, onSelect }: {
  person: PersonListItem;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <label className={`flex min-h-[6.5rem] cursor-pointer items-start gap-3 border-b border-default-200 px-4 py-3 text-sm last:border-b-0 ${selected ? 'bg-primary/10' : 'hover:bg-default-50'}`}>
      <input type="checkbox" checked={selected} disabled={disabled} onChange={onSelect} aria-label={`Выбрать: ${fullName(person)}`} className="mt-1 h-4 w-4 shrink-0 accent-primary" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-foreground">{fullName(person)}</span>
          <span className="text-xs text-default-500">{person.phone ?? 'тел. не указан'}</span>
        </span>
        <span className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-default-600">
          <span>Паспорт: {person.passportNumber ?? '—'}</span>
          <span>Код подразделения: {person.passportDepartmentCode ?? '—'}</span>
          <span>Выдан: {person.passportIssuedAt ? formatDate(person.passportIssuedAt) : '—'}</span>
          <span className="truncate" title={person.passportIssuedBy ?? ''}>Кем: {person.passportIssuedBy ?? '—'}</span>
        </span>
      </span>
    </label>
  );
}
