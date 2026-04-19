'use client';

import { Button } from '@heroui/react';
import { useEffect, useState } from 'react';
import { useUpdateEventMutation, type Currency, type ExcursionInput } from '@/lib/store/events-api';
import { formatMoney } from '@/lib/format';

const INPUT_CLS =
  'h-9 w-full rounded-md border border-default-300 bg-white px-2.5 text-sm text-foreground shadow-sm transition placeholder:text-default-400 hover:border-default-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-default-500">
          Всего: {items.length}
          {total > 0 ? ` · сумма: ${formatMoney(total, currency)}` : ''}
        </p>
        <Button type="button" variant="primary" size="sm" onPress={addRow}>
          + Добавить
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-default-500">
          Экскурсий нет. Нажмите «Добавить», чтобы завести первую.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-default-200">
          <table className="w-full text-sm">
            <thead className="bg-default-50 text-left text-xs uppercase tracking-wide text-default-500">
              <tr>
                <th className="px-3 py-2 w-8">#</th>
                <th className="px-3 py-2">Название</th>
                <th className="px-3 py-2 w-40">Стоимость ({currency})</th>
                <th className="px-3 py-2 w-24 text-right">Действия</th>
              </tr>
            </thead>
            <tbody>
              {items.map((ex, idx) => (
                <tr key={idx} className="border-t border-default-200">
                  <td className="px-3 py-1.5 text-default-500">{idx + 1}</td>
                  <td className="px-2 py-1.5">
                    <input
                      className={INPUT_CLS}
                      value={ex.name}
                      onChange={(e) => patch(idx, { name: e.currentTarget.value })}
                      placeholder="Например, Замок Паланок"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      className={INPUT_CLS}
                      value={ex.cost ?? ''}
                      onChange={(e) => patch(idx, { cost: e.currentTarget.value })}
                      inputMode="decimal"
                      placeholder="0.00"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button type="button" size="sm" variant="ghost" onPress={() => removeRow(idx)}>
                      Удалить
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button variant="primary" isDisabled={!dirty || isLoading} onPress={save}>
          {isLoading ? 'Сохранение…' : 'Сохранить экскурсии'}
        </Button>
        {dirty ? <span className="text-xs text-warning">Есть несохранённые изменения</span> : null}
      </div>
    </div>
  );
}
