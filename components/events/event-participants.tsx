'use client';

import { Button, Modal } from '@heroui/react';
import Link from 'next/link';
import { useState } from 'react';
import { Field } from '@/components/form-field';
import { FullScreenModal } from '@/components/full-screen-modal';
import { PaymentStatusChip } from '@/components/participations/payment-status-chip';
import {
  useAddParticipantMutation,
  useRemoveParticipationMutation,
  useUpdateParticipationMutation,
  type Currency,
  type ParticipationWithPerson,
  type PaymentStatus,
} from '@/lib/store/events-api';
import { useListPeopleQuery, type PersonListItem } from '@/lib/store/people-api';
import { formatMoney, fullName } from '@/lib/format';

interface Props {
  eventId: string;
  currency: Currency;
  participations: ParticipationWithPerson[];
}

export function EventParticipantsBlock({ eventId, currency, participations }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ParticipationWithPerson | null>(null);
  const [removeParticipation] = useRemoveParticipationMutation();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-default-500">Участников: {participations.length}</p>
        <Button variant="primary" onPress={() => setAddOpen(true)}>
          Добавить участника
        </Button>
      </div>

      {participations.length === 0 ? (
        <p className="text-sm text-default-500">Пока нет участников.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-default-200">
          <table className="w-full text-sm">
            <thead className="bg-default-50 text-left text-xs uppercase text-default-500">
              <tr>
                <th className="px-3 py-2">ФИО</th>
                <th className="px-3 py-2">Телефон</th>
                <th className="px-3 py-2">Паспорт</th>
                <th className="px-3 py-2">Оплата</th>
                <th className="px-3 py-2">Суммы</th>
                <th className="px-3 py-2 text-right">Действия</th>
              </tr>
            </thead>
            <tbody>
              {participations.map((p) => (
                <tr key={p.id} className="border-t border-default-200 hover:bg-default-50">
                  <td className="px-3 py-2">
                    <Link href={`/people/${p.person.id}`} className="text-primary hover:underline">
                      {fullName(p.person)}
                    </Link>
                    {p.person.deletedAt ? <span className="ml-2 text-xs text-warning">архив</span> : null}
                  </td>
                  <td className="px-3 py-2 text-default-600">{p.person.phone ?? '—'}</td>
                  <td className="px-3 py-2 text-default-600">{p.person.passportNumber ?? '—'}</td>
                  <td className="px-3 py-2">
                    <PaymentStatusChip status={p.paymentStatus} />
                  </td>
                  <td className="px-3 py-2 text-default-600">
                    {p.prepaidAmount ? `${formatMoney(p.prepaidAmount, currency)} предоплата` : ''}
                    {p.totalDue ? (
                      <span className={p.prepaidAmount ? 'ml-1 text-default-400' : ''}>
                        {p.prepaidAmount ? '/ ' : ''}
                        {formatMoney(p.totalDue, currency)} итого
                      </span>
                    ) : null}
                    {!p.prepaidAmount && !p.totalDue ? '—' : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" onPress={() => setEditing(p)}>
                      Изменить
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={async () => {
                        if (!confirm('Убрать участника из мероприятия?')) return;
                        await removeParticipation({ id: p.id, eventId, personId: p.personId });
                      }}
                    >
                      Убрать
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddParticipant eventId={eventId} open={addOpen} onClose={() => setAddOpen(false)} />
      <EditParticipation
        participation={editing}
        eventId={eventId}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function AddParticipant({
  eventId,
  open,
  onClose,
}: {
  eventId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [status, setStatus] = useState<PaymentStatus>('UNPAID');
  const [prepaid, setPrepaid] = useState('');
  const [totalDue, setTotalDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { data } = useListPeopleQuery({ q, pageSize: 10 });
  const [addParticipant, { isLoading }] = useAddParticipantMutation();

  async function submit() {
    if (!selectedPersonId) return;
    setError(null);
    try {
      await addParticipant({
        eventId,
        input: {
          personId: selectedPersonId,
          paymentStatus: status,
          prepaidAmount: prepaid.trim() || undefined,
          totalDue: totalDue.trim() || undefined,
        },
      }).unwrap();
      reset();
      onClose();
    } catch (err) {
      const e = err as { data?: { error?: { message?: string } } };
      setError(e.data?.error?.message ?? 'Не удалось добавить');
    }
  }

  function reset() {
    setQ('');
    setSelectedPersonId(null);
    setStatus('UNPAID');
    setPrepaid('');
    setTotalDue('');
    setError(null);
  }

  return (
    <FullScreenModal
      isOpen={open}
      onOpenChange={(v) => {
        if (!v) {
          reset();
          onClose();
        }
      }}
    >
      <Modal.Header className="flex items-center justify-between border-b border-default-200 px-6 py-4">
        <Modal.Heading className="text-base font-semibold">Добавить участника</Modal.Heading>
        <Modal.CloseTrigger />
      </Modal.Header>
      <Modal.Body className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <Field label="Поиск человека" value={q} onChange={setQ} placeholder="Фамилия, телефон, паспорт…" />
        <div className="overflow-hidden rounded-lg border border-default-200 bg-white">
          <div className="max-h-[calc(5*6.5rem)] overflow-y-auto">
            {data?.items.length === 0 ? (
              <p className="p-3 text-sm text-default-500">Никого не найдено.</p>
            ) : null}
            {data?.items.map((p) => (
              <PersonResultCard
                key={p.id}
                person={p}
                selected={selectedPersonId === p.id}
                onSelect={() => setSelectedPersonId(p.id)}
              />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">Статус оплаты</div>
          <div className="grid grid-cols-3 gap-2">
            {(['UNPAID', 'PREPAID', 'PAID'] as PaymentStatus[]).map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant={status === s ? 'primary' : 'outline'}
                onPress={() => setStatus(s)}
              >
                {s === 'UNPAID' ? 'Не оплачено' : s === 'PREPAID' ? 'Предоплата' : 'Оплачено'}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Предоплата" value={prepaid} onChange={setPrepaid} placeholder="0.00" inputMode="decimal" />
          <Field label="Итого" value={totalDue} onChange={setTotalDue} placeholder="0.00" inputMode="decimal" />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </Modal.Body>
      <Modal.Footer className="flex justify-end gap-2 border-t border-default-200 px-6 py-4">
        <Button variant="ghost" onPress={onClose}>Отмена</Button>
        <Button variant="primary" isDisabled={!selectedPersonId || isLoading} onPress={submit}>
          {isLoading ? 'Добавление…' : 'Добавить'}
        </Button>
      </Modal.Footer>
    </FullScreenModal>
  );
}

function PersonResultCard({
  person,
  selected,
  onSelect,
}: {
  person: PersonListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const issuedAt = person.passportIssuedAt
    ? new Date(person.passportIssuedAt).toLocaleDateString('ru-RU')
    : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        'flex w-full flex-col gap-1 border-b border-default-200 px-4 py-3 text-left text-sm last:border-b-0 min-h-[6.5rem]',
        selected ? 'bg-primary/10 ring-1 ring-inset ring-primary/30' : 'hover:bg-default-50',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-foreground">{fullName(person)}</span>
        <span className="shrink-0 text-xs text-default-500">{person.phone ?? 'тел. не указан'}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-default-600">
        <span>
          <span className="text-default-500">Паспорт: </span>
          {person.passportNumber ?? '—'}
        </span>
        <span>
          <span className="text-default-500">Код подразделения: </span>
          {person.passportDepartmentCode ?? '—'}
        </span>
        <span>
          <span className="text-default-500">Выдан: </span>
          {issuedAt ?? '—'}
        </span>
        <span className="truncate" title={person.passportIssuedBy ?? ''}>
          <span className="text-default-500">Кем: </span>
          {person.passportIssuedBy ?? '—'}
        </span>
      </div>
    </button>
  );
}

function EditParticipation({
  participation,
  eventId,
  onClose,
}: {
  participation: ParticipationWithPerson | null;
  eventId: string;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<PaymentStatus>(participation?.paymentStatus ?? 'UNPAID');
  const [prepaid, setPrepaid] = useState(participation?.prepaidAmount ?? '');
  const [totalDue, setTotalDue] = useState(participation?.totalDue ?? '');
  const [error, setError] = useState<string | null>(null);
  const [updateParticipation, { isLoading }] = useUpdateParticipationMutation();

  // При смене редактируемой записи переинициализируем состояние.
  const editingId = participation?.id ?? null;
  const [lastId, setLastId] = useState<string | null>(null);
  if (editingId !== lastId) {
    setLastId(editingId);
    setStatus(participation?.paymentStatus ?? 'UNPAID');
    setPrepaid(participation?.prepaidAmount ?? '');
    setTotalDue(participation?.totalDue ?? '');
    setError(null);
  }

  async function submit() {
    if (!participation) return;
    setError(null);
    try {
      await updateParticipation({
        id: participation.id,
        eventId,
        personId: participation.personId,
        data: {
          paymentStatus: status,
          prepaidAmount: prepaid.trim() || undefined,
          totalDue: totalDue.trim() || undefined,
        },
      }).unwrap();
      onClose();
    } catch (err) {
      const e = err as { data?: { error?: { message?: string } } };
      setError(e.data?.error?.message ?? 'Не удалось сохранить');
    }
  }

  return (
    <FullScreenModal isOpen={!!participation} onOpenChange={(v) => !v && onClose()}>
      <Modal.Header className="flex items-center justify-between border-b border-default-200 px-6 py-4">
        <Modal.Heading className="text-base font-semibold">
          {participation ? fullName(participation.person) : ''}
        </Modal.Heading>
        <Modal.CloseTrigger />
      </Modal.Header>
      <Modal.Body className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <div>
          <div className="mb-2 text-sm font-medium">Статус оплаты</div>
          <div className="grid grid-cols-3 gap-2">
            {(['UNPAID', 'PREPAID', 'PAID'] as PaymentStatus[]).map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant={status === s ? 'primary' : 'outline'}
                onPress={() => setStatus(s)}
              >
                {s === 'UNPAID' ? 'Не оплачено' : s === 'PREPAID' ? 'Предоплата' : 'Оплачено'}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Предоплата" value={prepaid} onChange={setPrepaid} inputMode="decimal" />
          <Field label="Итого" value={totalDue} onChange={setTotalDue} inputMode="decimal" />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </Modal.Body>
      <Modal.Footer className="flex justify-end gap-2 border-t border-default-200 px-6 py-4">
        <Button variant="ghost" onPress={onClose}>Отмена</Button>
        <Button variant="primary" isDisabled={isLoading} onPress={submit}>
          {isLoading ? 'Сохранение…' : 'Сохранить'}
        </Button>
      </Modal.Footer>
    </FullScreenModal>
  );
}
