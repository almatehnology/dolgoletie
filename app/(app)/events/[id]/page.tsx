'use client';

import { Button, Card, Spinner, Tabs } from '@heroui/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { EventForm } from '@/components/events/event-form';
import { EventParticipantsBlock } from '@/components/events/event-participants';
import {
  useDeleteEventMutation,
  useGetEventQuery,
  useRestoreEventMutation,
  useUpdateEventMutation,
} from '@/lib/store/events-api';
import { formatDateRange } from '@/lib/format';

export default function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, isLoading } = useGetEventQuery(id);
  const [updateEvent, { isLoading: saving }] = useUpdateEventMutation();
  const [deleteEvent] = useDeleteEventMutation();
  const [restoreEvent] = useRestoreEventMutation();
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 py-20 text-default-500">
        <Spinner /> Загрузка…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="py-20 text-center text-default-500">
        Мероприятие не найдено.{' '}
        <Link href="/events" className="text-primary hover:underline">
          К списку
        </Link>
      </div>
    );
  }

  const archived = !!data.deletedAt;

  return (
    <div className="flex flex-col gap-6">
      <nav className="text-sm text-default-500">
        <Link href="/events" className="hover:underline">
          Мероприятия
        </Link>
        <span> / </span>
        <span>{data.title}</span>
      </nav>

      <header className="sticky top-14 z-20 -mx-5 flex flex-wrap items-center justify-between gap-3 border-b border-default-200 bg-background/95 px-5 py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold">{data.title}</h1>
          <p className="text-xs text-default-500">
            {formatDateRange(data.startDate, data.endDate)} · {data.location}
          </p>
          {archived ? (
            <p className="text-xs text-warning">
              В архиве с {new Date(data.deletedAt!).toLocaleString('ru-RU')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`/api/events/${id}/export`}
            className="inline-flex h-10 items-center rounded-md border border-default-300 bg-white px-4 text-sm font-medium text-foreground shadow-sm transition hover:border-default-400 hover:bg-default-50"
          >
            Экспорт JSON
          </a>
          <a
            href={`/api/events/${id}/pdf`}
            className="inline-flex h-10 items-center rounded-md border border-default-300 bg-white px-4 text-sm font-medium text-foreground shadow-sm transition hover:border-default-400 hover:bg-default-50"
          >
            Экспорт в PDF
          </a>
          {archived ? (
            <Button variant="primary" onPress={() => restoreEvent(id)}>
              Восстановить
            </Button>
          ) : (
            <Button
              variant="danger-soft"
              onPress={async () => {
                if (!confirm('Переместить в архив?')) return;
                await deleteEvent(id);
                router.push('/events');
              }}
            >
              В архив
            </Button>
          )}
        </div>
      </header>

      {generalError ? <p className="text-sm text-danger">{generalError}</p> : null}

      <Tabs defaultSelectedKey="details">
        <Tabs.List className="flex gap-1 border-b border-default-200">
          <Tabs.Tab
            id="details"
            className="cursor-pointer border-b-2 border-transparent px-4 py-2 text-sm text-default-500 outline-none transition data-[selected=true]:border-primary data-[selected=true]:text-foreground data-[hovered=true]:text-foreground"
          >
            Основные данные
          </Tabs.Tab>
          <Tabs.Tab
            id="participants"
            className="cursor-pointer border-b-2 border-transparent px-4 py-2 text-sm text-default-500 outline-none transition data-[selected=true]:border-primary data-[selected=true]:text-foreground data-[hovered=true]:text-foreground"
          >
            Участники ({data.participations.length})
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel id="details" className="pt-6 outline-none">
          <EventForm
            mode="edit"
            submitting={saving}
            fieldErrors={errors}
            initial={{
              title: data.title,
              startDate: data.startDate,
              endDate: data.endDate,
              location: data.location,
              cost: data.cost ?? undefined,
              currency: data.currency,
              program: data.program ?? undefined,
              isOutbound: data.isOutbound,
              accommodationPlace: data.accommodationPlace ?? undefined,
              accommodationOrder: data.accommodationOrder ?? undefined,
              mealType: data.mealType ?? undefined,
              staysFrom: data.staysFrom ?? undefined,
              staysTo: data.staysTo ?? undefined,
              accommodationCost: data.accommodationCost ?? undefined,
              transportType: data.transportType ?? undefined,
              transportInfo: data.transportInfo ?? undefined,
              transportCost: data.transportCost ?? undefined,
              excursions: data.excursions.map((ex) => ({ id: ex.id, name: ex.name, cost: ex.cost ?? '' })),
            }}
            onSubmit={async (input) => {
              setErrors({});
              setGeneralError(null);
              try {
                await updateEvent({ id, data: input }).unwrap();
              } catch (err) {
                const e = err as { data?: { error?: { message?: string; fields?: Record<string, string[]> } } };
                setErrors(e.data?.error?.fields ?? {});
                setGeneralError(e.data?.error?.message ?? 'Не удалось сохранить');
              }
            }}
          />
        </Tabs.Panel>

        <Tabs.Panel id="participants" className="pt-6 outline-none">
          <Card>
            <Card.Content className="p-6">
              <EventParticipantsBlock
                eventId={id}
                currency={data.currency}
                participations={data.participations}
              />
            </Card.Content>
          </Card>
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
