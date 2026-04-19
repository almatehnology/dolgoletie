'use client';

import { Button, Spinner } from '@heroui/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { PersonForm } from '@/components/people/person-form';
import { PersonView } from '@/components/people/person-view';
import { PassportScansBlock } from '@/components/people/passport-scans';
import { PersonParticipationsBlock } from '@/components/people/person-participations';
import { TabNav } from '@/components/tab-nav';
import {
  useDeletePersonMutation,
  useGetPersonQuery,
  useRestorePersonMutation,
  useUpdatePersonMutation,
} from '@/lib/store/people-api';

export default function PersonDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, isLoading } = useGetPersonQuery(id);
  const [updatePerson, { isLoading: saving }] = useUpdatePersonMutation();
  const [deletePerson] = useDeletePersonMutation();
  const [restorePerson] = useRestorePersonMutation();
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

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
        Человек не найден.{' '}
        <Link href="/people" className="text-primary hover:underline">
          К списку
        </Link>
      </div>
    );
  }

  const archived = !!data.deletedAt;

  return (
    <div className="flex flex-col gap-6">
      <header className="sticky top-14 z-20 -mx-5 flex flex-wrap items-center justify-between gap-3 border-b border-default-200 bg-background/95 px-5 py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold">
            {data.lastName} {data.firstName} {data.middleName ?? ''}
          </h1>
          {archived ? (
            <p className="text-xs text-warning">
              В архиве с {new Date(data.deletedAt!).toLocaleString('ru-RU')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {!editing ? (
            <Button variant="primary" onPress={() => setEditing(true)}>
              Редактировать
            </Button>
          ) : (
            <Button variant="ghost" onPress={() => setEditing(false)}>
              Закрыть редактирование
            </Button>
          )}
          <a
            href={`/api/people/${id}/export`}
            className="inline-flex h-10 items-center rounded-md border border-default-300 bg-white px-4 text-sm font-medium text-foreground shadow-sm transition hover:border-default-400 hover:bg-default-50"
          >
            Экспорт JSON
          </a>
          <a
            href={`/api/people/${id}/pdf`}
            className="inline-flex h-10 items-center rounded-md border border-default-300 bg-white px-4 text-sm font-medium text-foreground shadow-sm transition hover:border-default-400 hover:bg-default-50"
          >
            Экспорт в PDF
          </a>
          {archived ? (
            <Button variant="primary" onPress={() => restorePerson(id)}>
              Восстановить
            </Button>
          ) : (
            <Button
              variant="danger-soft"
              onPress={async () => {
                if (!confirm('Переместить в архив?')) return;
                await deletePerson(id);
                router.push('/people');
              }}
            >
              В архив
            </Button>
          )}
        </div>
      </header>

      {generalError ? <p className="text-sm text-danger">{generalError}</p> : null}

      <TabNav
        items={[
          {
            id: 'details',
            label: 'Основные данные',
            content: (
              <div className="flex flex-col gap-6">
                {editing ? (
                  <PersonForm
                    mode="edit"
                    submitting={saving}
                    fieldErrors={errors}
                    initial={{
                      lastName: data.lastName,
                      firstName: data.firstName,
                      middleName: data.middleName ?? undefined,
                      phone: data.phone ?? undefined,
                      gender: data.gender ?? undefined,
                      birthPlace: data.birthPlace ?? undefined,
                      registrationAddress: data.registrationAddress ?? undefined,
                      passportNumber: data.passportNumber ?? undefined,
                      passportIssuedBy: data.passportIssuedBy ?? undefined,
                      passportIssuedAt: data.passportIssuedAt ?? undefined,
                      passportExpiresAt: data.passportExpiresAt ?? undefined,
                      passportDepartmentCode: data.passportDepartmentCode ?? undefined,
                      passportDetails: data.passportDetails ?? undefined,
                      notes: data.notes ?? undefined,
                    }}
                    onCancel={() => {
                      setEditing(false);
                      setErrors({});
                      setGeneralError(null);
                    }}
                    onSubmit={async (input) => {
                      setErrors({});
                      setGeneralError(null);
                      try {
                        await updatePerson({ id, data: input }).unwrap();
                        setEditing(false);
                      } catch (err) {
                        const e = err as {
                          data?: { error?: { message?: string; fields?: Record<string, string[]> } };
                        };
                        setErrors(e.data?.error?.fields ?? {});
                        setGeneralError(e.data?.error?.message ?? 'Не удалось сохранить');
                      }
                    }}
                  />
                ) : (
                  <PersonView person={data} />
                )}

                <section className="flex flex-col gap-2">
                  <h2 className="text-lg font-semibold text-foreground">Документы</h2>
                  <PassportScansBlock personId={id} scans={data.scans} />
                </section>
              </div>
            ),
          },
          {
            id: 'events',
            label: 'Мероприятия',
            badge: data.participations.length,
            content: (
              <PersonParticipationsBlock
                personId={id}
                participations={data.participations}
                currencyDefault="RUB"
              />
            ),
          },
        ]}
      />
    </div>
  );
}
