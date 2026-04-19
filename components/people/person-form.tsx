'use client';

import { Button, Card } from '@heroui/react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DatePickerField } from '@/components/date-picker-field';
import { Field, TextAreaField } from '@/components/form-field';
import { MaskedField, SelectField, formatDepartmentCode } from '@/components/select-field';
import { GENDER_OPTIONS } from '@/lib/validators';
import type { Gender, PersonInput } from '@/lib/store/people-api';

interface PersonFormProps {
  initial?: Partial<PersonInput>;
  mode: 'create' | 'edit';
  submitting?: boolean;
  fieldErrors?: Record<string, string[]>;
  onSubmit: (data: PersonInput) => Promise<unknown>;
  onCancel?: () => void;
}

function toInputDate(v?: string): string {
  if (!v) return '';
  return v.length >= 10 ? v.slice(0, 10) : v;
}

export function PersonForm({ initial, mode, submitting, fieldErrors, onSubmit, onCancel }: PersonFormProps) {
  const router = useRouter();
  const [lastName, setLastName] = useState(initial?.lastName ?? '');
  const [firstName, setFirstName] = useState(initial?.firstName ?? '');
  const [middleName, setMiddleName] = useState(initial?.middleName ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [gender, setGender] = useState<Gender | ''>(initial?.gender ?? '');
  const [birthPlace, setBirthPlace] = useState(initial?.birthPlace ?? '');
  const [registrationAddress, setRegistrationAddress] = useState(initial?.registrationAddress ?? '');
  const [passportNumber, setPassportNumber] = useState(initial?.passportNumber ?? '');
  const [passportIssuedBy, setPassportIssuedBy] = useState(initial?.passportIssuedBy ?? '');
  const [passportIssuedAt, setPassportIssuedAt] = useState(toInputDate(initial?.passportIssuedAt));
  const [passportExpiresAt, setPassportExpiresAt] = useState(toInputDate(initial?.passportExpiresAt));
  const [passportDepartmentCode, setPassportDepartmentCode] = useState(initial?.passportDepartmentCode ?? '');
  const [passportDetails, setPassportDetails] = useState(initial?.passportDetails ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const [advancedOpen, setAdvancedOpen] = useState(false);

  function pickError(name: string) {
    return fieldErrors?.[name]?.[0];
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit({
      lastName: lastName.trim(),
      firstName: firstName.trim(),
      middleName: middleName.trim() || undefined,
      phone: phone.trim() || undefined,
      gender: gender || undefined,
      birthPlace: birthPlace.trim() || undefined,
      registrationAddress: registrationAddress.trim() || undefined,
      passportNumber: passportNumber.trim() || undefined,
      passportIssuedBy: passportIssuedBy.trim() || undefined,
      passportIssuedAt: passportIssuedAt || undefined,
      passportExpiresAt: passportExpiresAt || undefined,
      passportDepartmentCode: passportDepartmentCode.trim() || undefined,
      passportDetails: passportDetails.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
      <Card>
        <Card.Header>
          <Card.Title>Основные данные</Card.Title>
          <Card.Description>ФИО, телефон и номер паспорта</Card.Description>
        </Card.Header>
        <Card.Content className="grid gap-x-4 gap-y-5 p-6 md:grid-cols-3">
          <Field label="Фамилия" value={lastName} onChange={setLastName} isRequired error={pickError('lastName')} autoComplete="family-name" />
          <Field label="Имя" value={firstName} onChange={setFirstName} isRequired error={pickError('firstName')} autoComplete="given-name" />
          <Field label="Отчество" value={middleName} onChange={setMiddleName} error={pickError('middleName')} autoComplete="additional-name" />
          <Field label="Телефон" value={phone} onChange={setPhone} placeholder="+7 900 000-00-00" error={pickError('phone')} inputMode="tel" autoComplete="tel" />
          <Field
            label="Серия и номер паспорта"
            value={passportNumber}
            onChange={setPassportNumber}
            error={pickError('passportNumber')}
            placeholder="0000 000000"
            className="md:col-span-2"
          />
        </Card.Content>
      </Card>

      <Card>
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center justify-between gap-3 p-6 text-left transition hover:bg-default-50"
        >
          <div>
            <Card.Title>Дополнительные поля</Card.Title>
            <Card.Description>
              Личные данные, паспортные реквизиты, адрес и примечания
            </Card.Description>
          </div>
          <span
            aria-hidden
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-default-200 text-default-600 transition ${
              advancedOpen ? 'rotate-180 bg-default-100' : ''
            }`}
          >
            ▾
          </span>
        </button>
        {advancedOpen ? (
          <div className="flex flex-col gap-6 border-t border-default-200 px-6 pb-6 pt-5">
            <section className="grid gap-x-4 gap-y-5 md:grid-cols-3">
              <SelectField<Gender>
                label="Пол"
                value={gender}
                onChange={setGender}
                options={GENDER_OPTIONS}
                error={pickError('gender')}
              />
              <Field
                label="Место рождения"
                value={birthPlace}
                onChange={setBirthPlace}
                error={pickError('birthPlace')}
                placeholder="Город / регион"
                className="md:col-span-2"
              />
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold text-foreground">Паспортные реквизиты</h3>
              <div className="grid gap-x-4 gap-y-5 md:grid-cols-3">
                <DatePickerField label="Дата выдачи" value={passportIssuedAt} onChange={setPassportIssuedAt} error={pickError('passportIssuedAt')} />
                <DatePickerField label="Срок действия" value={passportExpiresAt} onChange={setPassportExpiresAt} error={pickError('passportExpiresAt')} />
                <MaskedField
                  label="Код подразделения"
                  value={passportDepartmentCode}
                  onChange={setPassportDepartmentCode}
                  format={formatDepartmentCode}
                  placeholder="000-000"
                  inputMode="numeric"
                  maxLength={7}
                  helper="6 цифр в формате 000-000"
                  error={pickError('passportDepartmentCode')}
                />
                <Field
                  label="Кем выдан"
                  value={passportIssuedBy}
                  onChange={setPassportIssuedBy}
                  error={pickError('passportIssuedBy')}
                  className="md:col-span-3"
                />
                <Field
                  label="Адрес по прописке"
                  value={registrationAddress}
                  onChange={setRegistrationAddress}
                  error={pickError('registrationAddress')}
                  className="md:col-span-3"
                />
                <TextAreaField
                  label="Дополнительные реквизиты"
                  value={passportDetails}
                  onChange={setPassportDetails}
                  placeholder="Иные сведения по документу"
                  className="md:col-span-3"
                  error={pickError('passportDetails')}
                  rows={3}
                />
              </div>
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold text-foreground">Примечания</h3>
              <TextAreaField label="Свободный текст" value={notes} onChange={setNotes} rows={4} error={pickError('notes')} />
            </section>
          </div>
        ) : null}
      </Card>

      <div className="flex gap-2">
        <Button type="submit" variant="primary" isDisabled={submitting || !lastName || !firstName}>
          {submitting ? 'Сохранение…' : mode === 'create' ? 'Создать' : 'Сохранить'}
        </Button>
        <Button type="button" variant="ghost" onPress={() => (onCancel ? onCancel() : router.back())}>
          Отмена
        </Button>
      </div>
    </form>
  );
}
