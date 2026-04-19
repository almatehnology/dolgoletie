'use client';

import type { ReactNode } from 'react';
import type { PersonDetail } from '@/lib/store/people-api';
import { formatDate } from '@/lib/format';
import { GENDER_OPTIONS } from '@/lib/validators';

interface Props {
  person: PersonDetail;
}

function genderLabel(g?: string | null): string {
  if (!g) return '—';
  return GENDER_OPTIONS.find((o) => o.value === g)?.label ?? g;
}

function Row({ label, value, full }: { label: string; value: ReactNode; full?: boolean }) {
  const empty = value === null || value === undefined || value === '' || value === '—';
  return (
    <div className={full ? 'md:col-span-3' : ''}>
      <div className="text-[11px] uppercase tracking-wide text-default-500">{label}</div>
      <div className={`text-sm ${empty ? 'text-default-400' : 'text-foreground'}`}>
        {empty ? '—' : value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-default-500">{title}</h3>
      <div className="grid gap-x-6 gap-y-3 md:grid-cols-3">{children}</div>
    </section>
  );
}

export function PersonView({ person }: Props) {
  return (
    <div className="flex flex-col gap-5">
      <Section title="ФИО и личные данные">
        <Row label="Фамилия" value={person.lastName} />
        <Row label="Имя" value={person.firstName} />
        <Row label="Отчество" value={person.middleName} />
        <Row
          label="Телефон"
          value={
            person.phone ? (
              <a href={`tel:${person.phone}`} className="text-primary hover:underline">
                {person.phone}
              </a>
            ) : (
              '—'
            )
          }
        />
        <Row label="Пол" value={genderLabel(person.gender)} />
        <Row label="Место рождения" value={person.birthPlace} />
      </Section>

      <Section title="Паспорт">
        <Row label="Серия и номер" value={person.passportNumber} />
        <Row label="Дата выдачи" value={formatDate(person.passportIssuedAt)} />
        <Row label="Срок действия" value={formatDate(person.passportExpiresAt)} />
        <Row label="Кем выдан" value={person.passportIssuedBy} full />
        <Row label="Код подразделения" value={person.passportDepartmentCode} />
        <Row label="Адрес по прописке" value={person.registrationAddress} full />
        {person.passportDetails ? (
          <Row
            label="Дополнительные реквизиты"
            value={<span className="whitespace-pre-wrap">{person.passportDetails}</span>}
            full
          />
        ) : null}
      </Section>

      {person.notes ? (
        <Section title="Примечания">
          <Row
            label="Свободный текст"
            value={<span className="whitespace-pre-wrap">{person.notes}</span>}
            full
          />
        </Section>
      ) : null}
    </div>
  );
}
