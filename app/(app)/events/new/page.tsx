'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { EventForm } from '@/components/events/event-form';
import { useCreateEventMutation } from '@/lib/store/events-api';

export default function NewEventPage() {
  const router = useRouter();
  const [createEvent, { isLoading }] = useCreateEventMutation();
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <nav className="text-sm text-default-500">
        <Link href="/events" className="hover:underline">Мероприятия</Link> <span>/ новое</span>
      </nav>
      <h1 className="text-2xl font-semibold">Новое мероприятие</h1>
      {generalError ? <p className="text-sm text-danger">{generalError}</p> : null}
      <EventForm
        mode="create"
        submitting={isLoading}
        fieldErrors={errors}
        onSubmit={async (data) => {
          setErrors({});
          setGeneralError(null);
          try {
            const created = await createEvent(data).unwrap();
            router.push(`/events/${created.id}`);
          } catch (err) {
            const e = err as { data?: { error?: { message?: string; fields?: Record<string, string[]> } } };
            setErrors(e.data?.error?.fields ?? {});
            setGeneralError(e.data?.error?.message ?? 'Не удалось создать');
          }
        }}
      />
    </div>
  );
}
