'use client';

import { Button } from '@heroui/react';
import Link from 'next/link';
import { useState } from 'react';
import type { ParticipationWithEvent } from '@/lib/store/people-api';
import { AddPersonToEventDialog } from '@/components/participations/add-person-to-event';
import { PaymentStatusChip } from '@/components/participations/payment-status-chip';
import { formatMoney } from '@/lib/format';

interface Props {
  personId: string;
  participations: ParticipationWithEvent[];
  currencyDefault: 'RUB' | 'USD';
}

export function PersonParticipationsBlock({ personId, participations, currencyDefault }: Props) {
  const [open, setOpen] = useState(false);

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
                    {new Date(p.event.startDate).toLocaleDateString('ru-RU')} –{' '}
                    {new Date(p.event.endDate).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="px-3 py-2 text-default-600">{p.event.location}</td>
                  <td className="px-3 py-2">
                    <PaymentStatusChip status={p.paymentStatus} />
                  </td>
                  <td className="px-3 py-2 text-default-600">
                    {p.prepaidAmount ? `${formatMoney(p.prepaidAmount, p.event.currency)} предоплата` : ''}
                    {p.totalDue ? (
                      <span className={p.prepaidAmount ? 'ml-1 text-default-400' : ''}>
                        {p.prepaidAmount ? '/ ' : ''}
                        {formatMoney(p.totalDue, p.event.currency)} итого
                      </span>
                    ) : null}
                    {!p.prepaidAmount && !p.totalDue ? '—' : null}
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
    </div>
  );
}
