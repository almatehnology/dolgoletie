import { PERSON_FIELDS, type PersonFieldKey } from '@/lib/person-fields';

export type ReportContext = 'people' | 'event-details' | 'event-participants';
export type ReportFormat = 'pdf' | 'xlsx';
export type ReportOrientation = 'portrait' | 'landscape';
export interface ReportRequest {
  context: ReportContext;
  personIds?: string[];
  eventId?: string;
  fields: PersonFieldKey[];
  format: ReportFormat;
  orientation: ReportOrientation;
}
export const MAX_REPORT_PEOPLE = 10_000;
export const MAX_CELL_CHARACTERS = 32_767;
export const MAX_REPORT_CHARACTERS = 10_000_000;

export class ReportError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'ReportError';
  }
}

export function parseReportRequest(value: unknown): ReportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReportError('VALIDATION', 'Укажите параметры отчёта.');
  }
  const input = value as Record<string, unknown>;
  const keys = ['context', 'personIds', 'eventId', 'fields', 'format', 'orientation'];
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new ReportError('VALIDATION', 'Неизвестные параметры отчёта.');
  }
  if (typeof input.context !== 'string' || !['people', 'event-details', 'event-participants'].includes(input.context)) {
    throw new ReportError('VALIDATION', 'Выберите вид отчёта.');
  }
  if (input.format !== 'pdf' && input.format !== 'xlsx') {
    throw new ReportError('VALIDATION', 'Выберите формат PDF или XLSX.');
  }
  if (input.orientation !== 'portrait' && input.orientation !== 'landscape') {
    throw new ReportError('VALIDATION', 'Выберите ориентацию страницы.');
  }
  const knownFields = new Set<string>(PERSON_FIELDS.map((field) => field.key));
  if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > knownFields.size ||
      input.fields.some((key) => typeof key !== 'string' || !knownFields.has(key)) ||
      new Set(input.fields).size !== input.fields.length) {
    throw new ReportError('VALIDATION', 'Выберите хотя бы одно поле карточки без повторов.');
  }
  const result: ReportRequest = {
    context: input.context as ReportContext,
    fields: input.fields as PersonFieldKey[],
    format: input.format,
    orientation: input.orientation,
  };
  const validId = (id: unknown): id is string =>
    typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 200;
  if (result.context === 'people') {
    if (input.eventId !== undefined || !Array.isArray(input.personIds) || !input.personIds.length ||
        input.personIds.some((id) => !validId(id))) {
      throw new ReportError('VALIDATION', 'Выберите людей для экспорта.');
    }
    if (input.personIds.length > MAX_REPORT_PEOPLE) {
      throw new ReportError('REPORT_LIMIT', `За один раз можно экспортировать до ${MAX_REPORT_PEOPLE} людей.`, 413);
    }
    result.personIds = [...new Set(input.personIds as string[])];
  } else {
    if (input.personIds !== undefined || !validId(input.eventId)) {
      throw new ReportError('VALIDATION', 'Укажите мероприятие для экспорта всех участников.');
    }
    result.eventId = input.eventId;
  }
  return result;
}

export type PersonRecord = { id: string; deletedAt?: Date | string | null } &
  Partial<Record<PersonFieldKey, string | Date | null>>;
type DateValue = string | Date;
type MoneyValue = string | number | { toString(): string } | null;
export interface EventRecord {
  title: string;
  startDate: DateValue;
  endDate: DateValue;
  location?: string | null;
  cost?: MoneyValue;
  currency?: string;
  program?: string | null;
  isOutbound?: boolean;
  accommodationPlace?: string | null;
  accommodationOrder?: string | null;
  mealType?: string | null;
  staysFrom?: DateValue | null;
  staysTo?: DateValue | null;
  accommodationCost?: MoneyValue;
  transportType?: string | null;
  transportInfo?: string | null;
  transportCost?: MoneyValue;
  excursions: { name: string; cost?: MoneyValue }[];
  people: PersonRecord[];
}
export interface ReportColumn {
  key: PersonFieldKey;
  label: string;
  type: 'text' | 'date' | 'gender';
}
export interface TableReport {
  context: ReportContext;
  title: string;
  subtitle: string;
  summary: { label: string; value: string }[];
  columns: ReportColumn[];
  rows: string[][];
  emptyMessage: string;
}

// Dates on cards are calendar dates, including legacy DateTime passport fields.
// Formatting in UTC avoids moving YYYY-MM-DD to the previous day in Argentina.
export function reportDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  const iso = value instanceof Date ? value.toISOString() : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(iso);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : iso;
}

function dateRange(start?: DateValue | null, end?: DateValue | null): string {
  const a = reportDate(start);
  const b = reportDate(end);
  return a && b && a !== b ? `${a} – ${b}` : a || b;
}

export function reportValue(person: PersonRecord, column: ReportColumn): string {
  const value = person[column.key];
  if (value === null || value === undefined) return '';
  if (column.type === 'date') return reportDate(value);
  if (column.type === 'gender') {
    return ({ MALE: 'Мужской', FEMALE: 'Женский', OTHER: 'Другой' } as Record<string, string>)[String(value)] ?? String(value);
  }
  return String(value);
}

export function assertReportSize(report: TableReport): void {
  if (report.rows.length > MAX_REPORT_PEOPLE) {
    throw new ReportError('REPORT_LIMIT', `В отчёте больше ${MAX_REPORT_PEOPLE} людей. Разделите экспорт на части.`, 413);
  }
  let characters = 0;
  const inspect = (text: string) => {
    if (text.length > MAX_CELL_CHARACTERS) {
      throw new ReportError('REPORT_LIMIT', `Одно из значений длиннее ${MAX_CELL_CHARACTERS} символов. Сократите его или исключите поле.`, 413);
    }
    characters += text.length;
    if (characters > MAX_REPORT_CHARACTERS) {
      throw new ReportError('REPORT_LIMIT', 'Отчёт слишком большой. Разделите экспорт на части.', 413);
    }
  };
  inspect(report.title);
  inspect(report.subtitle);
  report.summary.forEach(({ label, value }) => { inspect(label); inspect(value); });
  report.columns.forEach(({ label }) => inspect(label));
  report.rows.forEach((row) => row.forEach(inspect));
}

export function buildTableReport(request: ReportRequest, people: PersonRecord[], event?: EventRecord): TableReport {
  const columns = request.fields.map((key) => {
    const field = PERSON_FIELDS.find((item) => item.key === key);
    if (!field) throw new ReportError('VALIDATION', 'Неизвестное поле карточки.');
    return { key: field.key, label: field.label, type: field.type };
  });
  if (request.context !== 'people' && !event) throw new ReportError('NOT_FOUND', 'Мероприятие не найдено.', 404);
  const report: TableReport = {
    context: request.context,
    title: event?.title ?? 'Список людей',
    subtitle: event ? dateRange(event.startDate, event.endDate) : `Выбрано людей: ${people.length}`,
    summary: [],
    columns,
    rows: people.map((person) => columns.map((column) => reportValue(person, column))),
    emptyMessage: request.context === 'people' ? 'Список людей пуст.' : 'В мероприятии нет участников.',
  };
  if (event && request.context === 'event-details') {
    const add = (label: string, value: unknown) => {
      if (value !== null && value !== undefined && String(value).trim()) report.summary.push({ label, value: String(value) });
    };
    const money = (value: MoneyValue | undefined) => value === null || value === undefined ? '' : `${value} ${event.currency ?? 'RUB'}`;
    add('Место', event.location);
    add('Формат', event.isOutbound ? 'Выездное мероприятие' : 'Местное мероприятие');
    add('Стоимость', money(event.cost));
    add('Программа', event.program);
    add('Размещение', event.accommodationPlace);
    add('Порядок размещения', event.accommodationOrder);
    add('Питание', event.mealType);
    add('Проживание', dateRange(event.staysFrom, event.staysTo));
    add('Стоимость размещения', money(event.accommodationCost));
    const transportNames: Record<string, string> = { BUS: 'Автобус', TRAIN: 'Поезд', PLANE: 'Самолёт', OTHER: 'Другое' };
    add('Транспорт', event.transportType ? transportNames[event.transportType] ?? event.transportType : null);
    add('Сведения о транспорте', event.transportInfo);
    add('Стоимость транспорта', money(event.transportCost));
    event.excursions.forEach((item) => add('Экскурсия', `${item.name}${money(item.cost) ? ` — ${money(item.cost)}` : ''}`));
  }
  assertReportSize(report);
  return report;
}
