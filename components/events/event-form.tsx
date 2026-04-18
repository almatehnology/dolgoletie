'use client';

import { Button, Card, Switch } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Field, TextAreaField } from '@/components/form-field';
import { SelectField } from '@/components/select-field';
import { CURRENCY_OPTIONS, MEAL_TYPE_OPTIONS, TRANSPORT_OPTIONS } from '@/lib/validators';
import type { Currency, EventInput, ExcursionInput, TransportType } from '@/lib/store/events-api';

interface Props {
  initial?: Partial<EventInput>;
  mode: 'create' | 'edit';
  submitting?: boolean;
  fieldErrors?: Record<string, string[]>;
  onSubmit: (data: EventInput) => Promise<unknown>;
  hideExcursions?: boolean;
}

function toInputDate(v?: string): string {
  if (!v) return '';
  return v.length >= 10 ? v.slice(0, 10) : v;
}

export function EventForm({ initial, mode, submitting, fieldErrors, onSubmit, hideExcursions }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [startDate, setStartDate] = useState(toInputDate(initial?.startDate));
  const [endDate, setEndDate] = useState(toInputDate(initial?.endDate));
  const [location, setLocation] = useState(initial?.location ?? '');
  const [cost, setCost] = useState(initial?.cost ?? '');
  const [currency, setCurrency] = useState<Currency>(initial?.currency ?? 'RUB');
  const [program, setProgram] = useState(initial?.program ?? '');
  const [isOutbound, setIsOutbound] = useState<boolean>(initial?.isOutbound ?? false);
  const [accommodationPlace, setAccommodationPlace] = useState(initial?.accommodationPlace ?? '');
  const [accommodationOrder, setAccommodationOrder] = useState(initial?.accommodationOrder ?? '');
  const [mealType, setMealType] = useState<string>(initial?.mealType ?? '');
  const [staysFrom, setStaysFrom] = useState(toInputDate(initial?.staysFrom));
  const [staysTo, setStaysTo] = useState(toInputDate(initial?.staysTo));
  const [accommodationCost, setAccommodationCost] = useState(initial?.accommodationCost ?? '');
  const [transportType, setTransportType] = useState<TransportType | ''>(initial?.transportType ?? '');
  const [transportInfo, setTransportInfo] = useState(initial?.transportInfo ?? '');
  const [transportCost, setTransportCost] = useState(initial?.transportCost ?? '');
  const [excursions, setExcursions] = useState<ExcursionInput[]>(initial?.excursions ?? []);

  function pickError(name: string) {
    return fieldErrors?.[name]?.[0];
  }

  function updateExcursion(idx: number, patch: Partial<ExcursionInput>) {
    setExcursions((cur) => cur.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  }
  function addExcursion() {
    setExcursions((cur) => [...cur, { name: '', cost: '' }]);
  }
  function removeExcursion(idx: number) {
    setExcursions((cur) => cur.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit({
      title: title.trim(),
      startDate,
      endDate,
      location: location.trim(),
      cost: cost.trim() || undefined,
      currency,
      program: program.trim() || undefined,
      isOutbound,
      accommodationPlace: isOutbound ? accommodationPlace.trim() || undefined : undefined,
      accommodationOrder: isOutbound ? accommodationOrder.trim() || undefined : undefined,
      mealType: isOutbound ? mealType || undefined : undefined,
      staysFrom: isOutbound ? staysFrom || undefined : undefined,
      staysTo: isOutbound ? staysTo || undefined : undefined,
      accommodationCost: isOutbound ? accommodationCost.trim() || undefined : undefined,
      transportType: isOutbound && transportType ? transportType : undefined,
      transportInfo: isOutbound ? transportInfo.trim() || undefined : undefined,
      transportCost: isOutbound ? transportCost.trim() || undefined : undefined,
      excursions: excursions
        .filter((ex) => ex.name.trim())
        .map((ex) => ({ name: ex.name.trim(), cost: ex.cost ? String(ex.cost).trim() : undefined })),
    });
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
      <Card>
        <Card.Header>
          <Card.Title>Общие данные</Card.Title>
        </Card.Header>
        <Card.Content className="grid gap-x-4 gap-y-5 p-6 md:grid-cols-2">
          <Field
            label="Название"
            value={title}
            onChange={setTitle}
            isRequired
            error={pickError('title')}
            className="md:col-span-2"
          />
          <Field label="Дата начала" type="date" value={startDate} onChange={setStartDate} isRequired error={pickError('startDate')} />
          <Field label="Дата окончания" type="date" value={endDate} onChange={setEndDate} isRequired error={pickError('endDate')} />
          <Field label="Место" value={location} onChange={setLocation} isRequired error={pickError('location')} className="md:col-span-2" />
          <Field label="Стоимость" value={cost} onChange={setCost} placeholder="0.00" inputMode="decimal" error={pickError('cost')} />
          <SelectField<Currency>
            label="Валюта"
            value={currency}
            onChange={(v) => v && setCurrency(v)}
            options={CURRENCY_OPTIONS}
            emptyLabel=""
            error={pickError('currency')}
          />
          <TextAreaField
            label="Программа"
            value={program}
            onChange={setProgram}
            rows={4}
            className="md:col-span-2"
            error={pickError('program')}
          />
        </Card.Content>
      </Card>

      <Card>
        <Card.Header className="flex items-center justify-between p-6 pb-4">
          <div>
            <Card.Title>Выездное мероприятие</Card.Title>
            <Card.Description>Размещение, питание, транспорт</Card.Description>
          </div>
          <Switch isSelected={isOutbound} onChange={setIsOutbound}>
            Выездное
          </Switch>
        </Card.Header>
        {isOutbound ? (
          <Card.Content className="grid gap-x-4 gap-y-5 p-6 pt-2 md:grid-cols-2">
            <Field label="Место размещения" value={accommodationPlace} onChange={setAccommodationPlace} className="md:col-span-2" />
            <Field label="Порядок размещения" value={accommodationOrder} onChange={setAccommodationOrder} placeholder="по 2 человека в номере" />
            <SelectField
              label="Тип питания"
              value={mealType}
              onChange={(v) => setMealType(v)}
              options={MEAL_TYPE_OPTIONS}
              error={pickError('mealType')}
            />
            <Field label="Проживание с" type="date" value={staysFrom} onChange={setStaysFrom} />
            <Field label="Проживание по" type="date" value={staysTo} onChange={setStaysTo} />
            <Field label="Стоимость размещения" value={accommodationCost} onChange={setAccommodationCost} inputMode="decimal" />
            <SelectField<TransportType>
              label="Транспорт"
              value={transportType}
              onChange={setTransportType}
              options={TRANSPORT_OPTIONS}
            />
            <Field
              label="Описание транспорта"
              value={transportInfo}
              onChange={setTransportInfo}
              placeholder="номер рейса, маршрут, время отправления"
              className="md:col-span-2"
            />
            <Field label="Стоимость билета" value={transportCost} onChange={setTransportCost} inputMode="decimal" />
          </Card.Content>
        ) : null}
      </Card>

      {hideExcursions ? null : (
        <Card>
          <Card.Header className="flex items-center justify-between p-6 pb-4">
            <Card.Title>Экскурсии</Card.Title>
            <Button type="button" variant="secondary" size="sm" onPress={addExcursion}>
              + Добавить
            </Button>
          </Card.Header>
          <Card.Content className="flex flex-col gap-3 p-6 pt-2">
            {excursions.length === 0 ? (
              <p className="text-sm text-default-500">Экскурсий нет.</p>
            ) : (
              excursions.map((ex, idx) => (
                <div key={idx} className="grid gap-3 md:grid-cols-[1fr_10rem_auto]">
                  <Field label="Название" value={ex.name} onChange={(v) => updateExcursion(idx, { name: v })} />
                  <Field
                    label="Стоимость"
                    value={ex.cost ?? ''}
                    onChange={(v) => updateExcursion(idx, { cost: v })}
                    inputMode="decimal"
                  />
                  <div className="flex items-end pb-0.5">
                    <Button type="button" size="sm" variant="ghost" onPress={() => removeExcursion(idx)}>
                      Удалить
                    </Button>
                  </div>
                </div>
              ))
            )}
          </Card.Content>
        </Card>
      )}

      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          isDisabled={submitting || !title || !startDate || !endDate || !location}
        >
          {submitting ? 'Сохранение…' : mode === 'create' ? 'Создать' : 'Сохранить'}
        </Button>
        <Button type="button" variant="ghost" onPress={() => router.back()}>
          Отмена
        </Button>
      </div>
    </form>
  );
}
