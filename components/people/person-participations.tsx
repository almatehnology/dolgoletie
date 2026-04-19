'use client';

import { Button, Modal } from '@heroui/react';
import Link from 'next/link';
import { useState } from 'react';
import type { ParticipationWithEvent } from '@/lib/store/people-api';
import { AddPersonToEventDialog } from '@/components/participations/add-person-to-event';
import { PaymentStatusChip } from '@/components/participations/payment-status-chip';
import { Field, TextAreaField } from '@/components/form-field';
import { FullScreenModal } from '@/components/full-screen-modal';
import {
  useRemoveParticipationMutation,
  useUpdateParticipationMutation,
  type PaymentStatus,
} from '@/lib/store/events-api';
import { formatDate, formatMoney } from '@/lib/format';

interface Props {
  personId: string;
  participations: ParticipationWithEvent[];
  currencyDefault: 'RUB' | 'USD';
}

export function PersonParticipationsBlock({ personId, participations, currencyDefault }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ParticipationWithEvent | null>(null);
  const [removeParticipation] = useRemoveParticipationMutation();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-default-500">
          Мероприятий: {participations.length}
        </p>
        <Button variant="primary" onPress={() => setOpen(true)}>
          Добавить в мероприятие
        </Button>
      </div>

      {participations.length === 0 ? (
        <p className="text-sm text-default-500">Пока не связан ни с одним мероприятием.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-default-200">
          <table className="w-full text-sm">
            <thead className="bg-default-50 text-left text-xs uppercase text-default-500">
              <tr>
                <th className="px-3 py-2">Мероприятие</th>
                <th className="px-3 py-2">Даты</th>
                <th className="px-3 py-2">Место</th>
                <th className="px-3 py-2">Оплата</th>
                <th className="px-3 py-2">Сумма</th>
                <th className="px-3 py-2 text-right">Действия</th>
              </tr>
            </thead>
            <tbody>
              {participations.map((p) => (
                <tr key={p.id} className="border-t border-default-200 hover:bg-default-50">
                  <td className="px-3 py-2">
                    <Link href={`/events/${p.event.id}`} className="text-primary hover:underline">
                      {p.event.title}
                    </Link>
                    {p.event.deletedAt ? <span className="ml-2 text-xs text-warning">архив</span> : null}
                  </td>
                  <td className="px-3 py-2 text-default-600">
                    {formatDate(p.event.startDate)} – {formatDate(p.event.endDate)}
                  </td>
                  <td className="px-3 py-2 text-default-600">{p.event.location}</td>
                  <td className="px-3 py-2">
                    <PaymentStatusChip status={p.paymentStatus} />
                  </td>
                  <td className="px-3 py-2 text-default-600">
                    {p.prepaidAmount ? formatMoney(p.prepaidAmount, p.event.currency) : ''}
                    {p.totalDue ? (
                      <span className={p.prepaidAmount ? 'ml-1 text-default-400' : ''}>
                        {p.prepaidAmount ? '/ ' : ''}
                        {formatMoney(p.totalDue, p.event.currency)} итого
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
                        await removeParticipation({
                          id: p.id,
                          eventId: p.event.id,
                          personId: p.personId,
                        });
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

      <AddPersonToEventDialog
        open={open}
        onOpenChange={setOpen}
        personId={personId}
        currencyDefault={currencyDefault}
      />

      <EditParticipation participation={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function EditParticipation({
  participation,
  onClose,
}: {
  participation: ParticipationWithEvent | null;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<PaymentStatus>(participation?.paymentStatus ?? 'UNPAID');
  const [prepaid, setPrepaid] = useState(participation?.prepaidAmount ?? '');
  const [totalDue, setTotalDue] = useState(participation?.totalDue ?? '');
  const [notes, setNotes] = useState(participation?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [updateParticipation, { isLoading }] = useUpdateParticipationMutation();

  const editingId = participation?.id ?? null;
  const [lastId, setLastId] = useState<string | null>(null);
  if (editingId !== lastId) {
    setLastId(editingId);
    setStatus(participation?.paymentStatus ?? 'UNPAID');
    setPrepaid(participation?.prepaidAmount ?? '');
    setTotalDue(participation?.totalDue ?? '');
    setNotes(participation?.notes ?? '');
    setError(null);
  }

  async function submit() {
    if (!participation) return;
    setError(null);
    try {
      await updateParticipation({
        id: participation.id,
        eventId: participation.event.id,
        personId: participation.personId,
        data: {
          paymentStatus: status,
          prepaidAmount: prepaid.trim() || undefined,
          totalDue: totalDue.trim() || undefined,
          notes: notes.trim() || undefined,
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
        <Modal.Heading className="truncate text-base font-semibold">
          {participation?.event.title ?? ''}
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
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label={`Предоплата (${participation?.event.currency ?? ''})`}
            value={prepaid}
            onChange={setPrepaid}
            inputMode="decimal"
            placeholder="0.00"
          />
          <Field
            label={`Итого (${participation?.event.currency ?? ''})`}
            value={totalDue}
            onChange={setTotalDue}
            inputMode="decimal"
            placeholder="0.00"
          />
        </div>
        <TextAreaField label="Примечания" value={notes} onChange={setNotes} rows={3} />
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
