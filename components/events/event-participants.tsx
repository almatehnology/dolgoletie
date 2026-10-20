'use client';

import { Button, Modal } from '@heroui/react';
import Link from 'next/link';
import { useState } from 'react';
import { ExportDialog } from '@/components/export-dialog';
import { Field } from '@/components/form-field';
import { FullScreenModal } from '@/components/full-screen-modal';
import { AddParticipants } from '@/components/events/add-participants';
import { PaymentStatusChip } from '@/components/participations/payment-status-chip';
import {
  useRemoveParticipationMutation,
  useUpdateParticipationMutation,
  type Currency,
  type ParticipationWithPerson,
  type PaymentStatus,
} from '@/lib/store/events-api';
import { formatMoney, fullName } from '@/lib/format';

interface Props {
  eventId: string;
  eventTitle?: string;
  currency: Currency;
  participations: ParticipationWithPerson[];
}

export function EventParticipantsBlock({ eventId, eventTitle, currency, participations }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [editing, setEditing] = useState<ParticipationWithPerson | null>(null);
  const [removeParticipation] = useRemoveParticipationMutation();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-default-500">Участников: {participations.length}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onPress={() => setExportOpen(true)}>
            Экспортировать участников ({participations.length})
          </Button>
          <Button variant="primary" onPress={() => setAddOpen(true)}>
            Добавить участников
          </Button>
        </div>
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
                    {p.prepaidAmount ? formatMoney(p.prepaidAmount, currency) : ''}
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

      {addOpen ? (
        <AddParticipants
          eventId={eventId}
          existingPersonIds={participations.map((p) => p.personId)}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
      <EditParticipation
        participation={editing}
        eventId={eventId}
        onClose={() => setEditing(null)}
      />
      <ExportDialog
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        context="event-participants"
        eventId={eventId}
        eventTitle={eventTitle}
        participantCount={participations.length}
      />
    </div>
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
        <div className="flex flex-col gap-3">
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
