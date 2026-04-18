'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PersonForm } from '@/components/people/person-form';
import { useCreatePersonMutation } from '@/lib/store/people-api';

export default function NewPersonPage() {
  const router = useRouter();
  const [createPerson, { isLoading }] = useCreatePersonMutation();
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <nav className="text-sm text-default-500">
        <Link href="/people" className="hover:underline">Люди</Link> <span>/ новый</span>
      </nav>
      <h1 className="text-2xl font-semibold">Новый человек</h1>
      {generalError ? <p className="text-sm text-danger">{generalError}</p> : null}
      <PersonForm
        mode="create"
        submitting={isLoading}
        fieldErrors={errors}
        onSubmit={async (data) => {
          setErrors({});
          setGeneralError(null);
          try {
            const created = await createPerson(data).unwrap();
            router.push(`/people/${created.id}`);
          } catch (err) {
            const e = err as { data?: { error?: { message?: string; fields?: Record<string, string[]> } } };
            setErrors(e.data?.error?.fields ?? {});
            setGeneralError(e.data?.error?.message ?? 'Не удалось создать запись');
          }
        }}
      />
    </div>
  );
}
