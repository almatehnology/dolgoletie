export const PERSON_FIELDS = [
  { key: 'lastName', label: 'Фамилия', type: 'text', aliases: ['фамилия'] },
  { key: 'firstName', label: 'Имя', type: 'text', aliases: ['имя'] },
  { key: 'middleName', label: 'Отчество', type: 'text', aliases: ['отчество'] },
  { key: 'phone', label: 'Телефон', type: 'text', aliases: ['телефон', 'тел', 'мобильный телефон', 'моб телефон', 'номер телефона'] },
  { key: 'birthDate', label: 'Дата рождения', type: 'date', aliases: ['дата рождения', 'др', 'д р', 'день рождения'] },
  { key: 'gender', label: 'Пол', type: 'gender', aliases: ['пол'] },
  { key: 'birthPlace', label: 'Место рождения', type: 'text', aliases: ['место рождения'] },
  { key: 'registrationAddress', label: 'Адрес регистрации', type: 'text', aliases: ['адрес регистрации', 'прописка', 'адрес по прописке'] },
  { key: 'passportNumber', label: 'Серия и номер паспорта', type: 'text', aliases: ['паспорт', 'серия и номер паспорта', 'паспортные данные'] },
  { key: 'passportIssuedBy', label: 'Кем выдан паспорт', type: 'text', aliases: ['кем выдан', 'кем выдан паспорт'] },
  { key: 'passportIssuedAt', label: 'Дата выдачи паспорта', type: 'date', aliases: ['дата выдачи', 'дата выдачи паспорта'] },
  { key: 'passportExpiresAt', label: 'Срок действия паспорта', type: 'date', aliases: ['срок действия', 'действителен до'] },
  { key: 'passportDepartmentCode', label: 'Код подразделения', type: 'text', aliases: ['код подразделения'] },
  { key: 'passportDetails', label: 'Дополнительные реквизиты', type: 'text', aliases: ['дополнительные реквизиты', 'реквизиты'] },
  { key: 'notes', label: 'Примечания', type: 'text', aliases: ['примечания', 'примечание', 'комментарий'] },
] as const;
export type PersonFieldKey = typeof PERSON_FIELDS[number]['key'];

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
