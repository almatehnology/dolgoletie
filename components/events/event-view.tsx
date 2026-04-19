'use client';

import type { ReactNode } from 'react';
import type { EventDetail } from '@/lib/store/events-api';
import { formatDate, formatMoney } from '@/lib/format';
import { MEAL_TYPE_OPTIONS, TRANSPORT_OPTIONS } from '@/lib/validators';

interface Props {
  event: EventDetail;
}

function mealLabel(v?: string | null): string {
  if (!v) return '—';
  return MEAL_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

function transportLabel(v?: string | null): string {
  if (!v) return '—';
  return TRANSPORT_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

function Row({
  label,
  value,
  span,
}: {
  label: string;
  value: ReactNode;
  span?: 2 | 3;
}) {
  const empty = value === null || value === undefined || value === '' || value === '—';
  const spanCls = span === 3 ? 'md:col-span-3' : span === 2 ? 'md:col-span-2' : '';
  return (
    <div className={spanCls}>
      <div className="text-[11px] uppercase tracking-wide text-default-500">{label}</div>
      <div className={`text-sm ${empty ? 'text-default-400' : 'text-foreground'}`}>
        {empty ? '—' : value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      <div className="grid gap-x-6 gap-y-3 md:grid-cols-3">{children}</div>
    </section>
  );
}

export function EventView({ event }: Props) {
  const excursionsTotal = event.excursions.reduce((sum, ex) => {
    const n = Number(ex.cost);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);

  return (
    <div className="flex flex-col gap-5">
      <Section title="Общие данные">
        <Row label="Дата начала" value={formatDate(event.startDate)} />
        <Row label="Дата окончания" value={formatDate(event.endDate)} />
        <Row label="Тип" value={event.isOutbound ? 'Выездное' : 'Без выезда'} />
        <Row label="Место" value={event.location} span={3} />
        <Row label="Стоимость" value={formatMoney(event.cost, event.currency)} />
        <Row label="Валюта" value={event.currency === 'RUB' ? 'Рубль (₽)' : 'Доллар ($)'} />
        {event.program ? (
          <Row
            label="Программа"
            value={<span className="whitespace-pre-wrap">{event.program}</span>}
            span={3}
          />
        ) : null}
      </Section>

      {event.isOutbound ? (
        <Section title="Размещение и транспорт">
          <Row label="Место размещения" value={event.accommodationPlace} span={3} />
          <Row label="Порядок размещения" value={event.accommodationOrder} />
          <Row label="Тип питания" value={mealLabel(event.mealType)} />
          <Row
            label="Стоимость размещения"
            value={formatMoney(event.accommodationCost, event.currency)}
          />
          <Row label="Проживание с" value={formatDate(event.staysFrom)} />
          <Row label="Проживание по" value={formatDate(event.staysTo)} />
          <Row label="Транспорт" value={transportLabel(event.transportType)} />
          <Row label="Описание транспорта" value={event.transportInfo} span={2} />
          <Row
            label="Стоимость билета"
            value={formatMoney(event.transportCost, event.currency)}
          />
        </Section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold text-foreground">Экскурсии</h2>
          <span className="text-xs text-default-500">
            Всего: {event.excursions.length}
            {excursionsTotal > 0
              ? ` · сумма: ${formatMoney(excursionsTotal, event.currency)}`
              : ''}
          </span>
        </div>
        {event.excursions.length === 0 ? (
          <p className="text-sm text-default-400">—</p>
        ) : (
          <ul className="flex flex-col divide-y divide-default-200 rounded-md border border-default-200">
            {event.excursions.map((ex) => (
              <li
                key={ex.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="truncate text-foreground">{ex.name}</span>
                <span className="shrink-0 text-default-600">
                  {ex.cost ? formatMoney(ex.cost, event.currency) : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
