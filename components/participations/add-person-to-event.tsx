'use client';

import { Button, Modal } from '@heroui/react';
import { useState } from 'react';
import { Field } from '@/components/form-field';
import { FullScreenModal } from '@/components/full-screen-modal';
import { useListEventsQuery, useAddParticipantMutation, type PaymentStatus, type Currency } from '@/lib/store/events-api';
import { formatDateRange } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personId: string;
  currencyDefault: Currency;
}

export function AddPersonToEventDialog({ open, onOpenChange, personId }: Props) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<PaymentStatus>('UNPAID');
  const [prepaid, setPrepaid] = useState('');
  const [totalDue, setTotalDue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data } = useListEventsQuery({ q, pageSize: 10 });
  const [addParticipant, { isLoading }] = useAddParticipantMutation();

  async function submit() {
    if (!selected) return;
    setError(null);
    try {
      await addParticipant({
        eventId: selected,
        input: {
          personId,
          paymentStatus: status,
          prepaidAmount: prepaid.trim() || undefined,
          totalDue: totalDue.trim() || undefined,
        },
      }).unwrap();
      reset();
      onOpenChange(false);
    } catch (err) {
      const e = err as { data?: { error?: { message?: string } } };
      setError(e.data?.error?.message ?? 'Не удалось добавить');
    }
  }

  function reset() {
    setQ('');
    setSelected(null);
    setStatus('UNPAID');
    setPrepaid('');
    setTotalDue('');
    setError(null);
  }

  return (
    <FullScreenModal
      isOpen={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <Modal.Header className="flex items-center justify-between border-b border-default-200 px-6 py-4">
        <Modal.Heading className="text-base font-semibold">Добавить в мероприятие</Modal.Heading>
        <Modal.CloseTrigger />
      </Modal.Header>
      <Modal.Body className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <Field label="Поиск мероприятия" value={q} onChange={setQ} placeholder="Название, место…" />
        <div className="max-h-72 min-h-24 overflow-y-auto rounded-lg border border-default-200 bg-white">
          {data?.items.length === 0 ? (
            <p className="p-3 text-sm text-default-500">Нет подходящих мероприятий.</p>
          ) : null}
          {data?.items.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setSelected(e.id)}
              className={[
                'flex w-full flex-col items-start gap-0.5 border-b border-default-200 px-3 py-2 text-left text-sm last:border-b-0',
                selected === e.id ? 'bg-primary/10' : 'hover:bg-default-50',
              ].join(' ')}
            >
              <span className="font-medium">{e.title}</span>
              <span className="text-xs text-default-500">
                {formatDateRange(e.startDate, e.endDate)} · {e.location}
              </span>
            </button>
          ))}
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
        <div className="flex flex-col gap-3">
          <Field label="Предоплата" value={prepaid} onChange={setPrepaid} placeholder="0.00" inputMode="decimal" />
          <Field label="Итого" value={totalDue} onChange={setTotalDue} placeholder="0.00" inputMode="decimal" />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </Modal.Body>
      <Modal.Footer className="flex justify-end gap-2 border-t border-default-200 px-6 py-4">
        <Button variant="ghost" onPress={() => onOpenChange(false)}>
          Отмена
        </Button>
        <Button variant="primary" isDisabled={!selected || isLoading} onPress={submit}>
          {isLoading ? 'Добавление…' : 'Добавить'}
        </Button>
      </Modal.Footer>
    </FullScreenModal>
  );
}
