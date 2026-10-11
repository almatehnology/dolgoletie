import { PERSON_FIELDS, type PersonFieldKey } from '@/lib/person-fields';
import type { Cell } from './types';
import type { Values } from './types';

export const cleanText = (value: string) => value.normalize('NFC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
export const nameKey = (value: string) => cleanText(value).toLocaleLowerCase('ru').replace(/ё/g, 'е');
export const hasInitials = (values: Values) => (['lastName', 'firstName', 'middleName'] as const).some((key) => /(?:^|\s)(?:\p{L}[.]\s*)*\p{L}[.]?(?=\s|$)/u.test(values[key] ?? ''));
export function compareKey(key: PersonFieldKey, value: string): string {
  if (key === 'passportNumber') return nameKey(value).replace(/\s/g, '');
  if (key === 'phone') return value.replace(/[\s()\-]/g, '');
  return nameKey(value);
}
export function calendarDate(value: string): string | null {
  let parts: string[];
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) parts = value.split('-');
  else if (/^\d{1,2}[.]\d{1,2}[.]\d{4}$/.test(value)) parts = value.split('.').reverse();
  else return null;
  const [y, m, d] = parts.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1000 || y > 9999 || date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function excelDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || (!date1904 && Math.floor(serial) === 60)) return null;
  const days = Math.floor(serial) - (!date1904 && serial > 60 ? 1 : 0);
  const date = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31) + days * 86400000);
  return calendarDate(date.toISOString().slice(0, 10));
}
export function normalizeValue(key: PersonFieldKey, cell: Cell, date1904 = false): string {
  const text = cleanText(cell.text);
  if (!text) return '';
  if (cell.error) throw new Error(cell.error);
  const type = PERSON_FIELDS.find((f) => f.key === key)?.type;
  if (type === 'date') {
    const date = cell.date ? calendarDate(cell.date) : cell.number !== undefined ? excelDate(cell.number, date1904) : calendarDate(text);
    if (!date) throw new Error('Ожидается действительная дата ДД.ММ.ГГГГ или ГГГГ-ММ-ДД; неоднозначные даты нужно исправить.');
    return date;
  }
  if (type === 'gender') {
    const genders: Record<string, string> = { м: 'MALE', муж: 'MALE', мужской: 'MALE', male: 'MALE', ж: 'FEMALE', жен: 'FEMALE', женский: 'FEMALE', female: 'FEMALE', other: 'OTHER', иное: 'OTHER', другой: 'OTHER' };
    const gender = genders[nameKey(text)];
    if (!gender) throw new Error('Пол: мужской, женский или иное.');
    return gender;
  }
  if (key === 'passportDepartmentCode' && !/^\d{3}-\d{3}$/.test(text)) throw new Error('Код подразделения должен иметь вид 000-000.');
  return text;
}
export function splitFullName(value: string) {
  const parts = cleanText(value).split(' ');
  const confident = (parts.length === 2 || parts.length === 3) && parts.every((p) => /^[\p{L}]{2,}(?:-[\p{L}]{2,})?$/u.test(p));
  return { lastName: parts[0] ?? '', firstName: parts[1] ?? '', middleName: parts.slice(2).join(' '), warning: confident ? null : 'Разбиение ФИО требует проверки: инициалы, составное или неполное имя.' };
}
