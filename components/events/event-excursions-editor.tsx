'use client';

import { Button, Card } from '@heroui/react';
import { useEffect, useState } from 'react';
import { Field } from '@/components/form-field';
import { useUpdateEventMutation, type Currency, type ExcursionInput } from '@/lib/store/events-api';
import { formatMoney } from '@/lib/format';

interface Props {
  eventId: string;
  currency: Currency;
  excursions: Array<{ id: string; name: string; cost: string | null }>;
}

export function EventExcursionsEditor({ eventId, currency, excursions }: Props) {
  const [items, setItems] = useState<ExcursionInput[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateEvent, { isLoading }] = useUpdateEventMutation();

  // Синхронизируемся с данными с сервера при смене мероприятия или после сохранения.
  useEffect(() => {
    setItems(excursions.map((e) => ({ id: e.id, name: e.name, cost: e.cost ?? '' })));
    setDirty(false);
  }, [excursions]);

  function patch(idx: number, value: Partial<ExcursionInput>) {
    setItems((cur) => cur.map((e, i) => (i === idx ? { ...e, ...value } : e)));
    setDirty(true);
  }
  function addRow() {
    setItems((cur) => [...cur, { name: '', cost: '' }]);
    setDirty(true);
  }
  function removeRow(idx: number) {
    setItems((cur) => cur.filter((_, i) => i !== idx));
    setDirty(true);
  }

  async function save() {
    setError(null);
    try {
      await updateEvent({
        id: eventId,
        data: {
          excursions: items
            .filter((ex) => ex.name.trim())
            .map((ex) => ({
              name: ex.name.trim(),
              cost: ex.cost ? String(ex.cost).trim() : undefined,
            })),
        },
      }).unwrap();
      setDirty(false);
    } catch (err) {
      const e = err as { data?: { error?: { message?: string } } };
      setError(e.data?.error?.message ?? 'Не удалось сохранить');
    }
  }

  const total = items.reduce((sum, ex) => {
    const n = Number(ex.cost);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);

  return (
    <Card>
      <Card.Header className="flex items-center justify-between p-6 pb-4">
        <div>
          <Card.Title>Экскурсии</Card.Title>
          <Card.Description>
            Всего: {items.length}
            {total > 0 ? ` · сумма: ${formatMoney(total, currency)}` : ''}
          </Card.Description>
        </div>
        <Button type="button" variant="secondary" size="sm" onPress={addRow}>
          + Добавить
        </Button>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3 p-6 pt-2">
        {items.length === 0 ? (
          <p className="text-sm text-default-500">Экскурсий нет. Нажмите «Добавить», чтобы завести первую.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((ex, idx) => (
              <div
                key={idx}
                className="flex flex-col gap-3 rounded-lg border border-default-200 bg-default-50/40 p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-default-500">
                    Экскурсия #{idx + 1}
                  </span>
                  <Button type="button" size="sm" variant="ghost" onPress={() => removeRow(idx)}>
                    Удалить
                  </Button>
                </div>
                <Field
                  label="Название"
                  value={ex.name}
                  onChange={(v) => patch(idx, { name: v })}
                  placeholder="Например, Замок Паланок"
                />
                <Field
                  label={`Стоимость (${currency})`}
                  value={ex.cost ?? ''}
                  onChange={(v) => patch(idx, { cost: v })}
                  inputMode="decimal"
                  placeholder="0.00"
                />
              </div>
            ))}
          </div>
        )}

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <div className="flex items-center gap-2 pt-2">
          <Button variant="primary" isDisabled={!dirty || isLoading} onPress={save}>
            {isLoading ? 'Сохранение…' : 'Сохранить экскурсии'}
          </Button>
          {dirty ? <span className="text-xs text-warning">Есть несохранённые изменения</span> : null}
        </div>
      </Card.Content>
    </Card>
  );
}
