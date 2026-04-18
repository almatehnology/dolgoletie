import { z } from 'zod';

const optionalString = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const optionalIsoDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined))
  .pipe(
    z
      .string()
      .datetime({ offset: true })
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .optional(),
  );

const optionalDecimal = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
  .refine((v) => v === '' || /^-?\d+(\.\d+)?$/.test(v), { message: 'Ожидается число' })
  .transform((v) => (v === '' ? undefined : v))
  .optional();

export const currencySchema = z.enum(['RUB', 'USD']);
export const paymentStatusSchema = z.enum(['UNPAID', 'PREPAID', 'PAID']);
export const transportTypeSchema = z.enum(['BUS', 'TRAIN', 'PLANE', 'OTHER']);
export const genderSchema = z.enum(['MALE', 'FEMALE', 'OTHER']);

export const MEAL_TYPE_OPTIONS = [
  { value: 'NONE', label: 'Без питания' },
  { value: 'BREAKFAST', label: 'Завтрак' },
  { value: 'HALF_BOARD', label: 'Полупансион' },
  { value: 'FULL_BOARD', label: 'Полный пансион' },
  { value: 'ALL_INCLUSIVE', label: 'Всё включено' },
  { value: 'ULTRA_ALL_INCLUSIVE', label: 'Ультра всё включено' },
] as const;

export type MealTypeValue = (typeof MEAL_TYPE_OPTIONS)[number]['value'];

export const GENDER_OPTIONS = [
  { value: 'MALE', label: 'Мужской' },
  { value: 'FEMALE', label: 'Женский' },
  { value: 'OTHER', label: 'Иное' },
] as const;

export const TRANSPORT_OPTIONS = [
  { value: 'BUS', label: 'Автобус' },
  { value: 'TRAIN', label: 'Поезд' },
  { value: 'PLANE', label: 'Самолёт' },
  { value: 'OTHER', label: 'Другое' },
] as const;

export const CURRENCY_OPTIONS = [
  { value: 'RUB', label: 'Рубль (₽)' },
  { value: 'USD', label: 'Доллар ($)' },
] as const;

const departmentCodeSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .pipe(z.string().regex(/^\d{3}-\d{3}$/, 'Код подразделения: 000-000').optional());

export const personCreateSchema = z.object({
  lastName: z.string().trim().min(1, 'Фамилия обязательна'),
  firstName: z.string().trim().min(1, 'Имя обязательно'),
  middleName: optionalString,
  phone: optionalString,
  gender: genderSchema.optional(),
  birthPlace: optionalString,
  registrationAddress: optionalString,
  passportNumber: optionalString,
  passportIssuedBy: optionalString,
  passportIssuedAt: optionalIsoDate,
  passportExpiresAt: optionalIsoDate,
  passportDepartmentCode: departmentCodeSchema,
  passportDetails: optionalString,
  notes: optionalString,
});

export const personUpdateSchema = personCreateSchema.partial();

export const excursionSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1),
  cost: optionalDecimal,
});

const eventBaseSchema = z.object({
  title: z.string().trim().min(1, 'Название обязательно'),
  startDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  endDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  location: z.string().trim().min(1, 'Место обязательно'),
  cost: optionalDecimal,
  currency: currencySchema.default('RUB'),
  program: optionalString,
  isOutbound: z.boolean().default(false),
  accommodationPlace: optionalString,
  accommodationOrder: optionalString,
  mealType: optionalString,
  staysFrom: optionalIsoDate,
  staysTo: optionalIsoDate,
  accommodationCost: optionalDecimal,
  transportType: transportTypeSchema.optional(),
  transportInfo: optionalString,
  transportCost: optionalDecimal,
  excursions: z.array(excursionSchema).default([]),
});

export const eventCreateSchema = eventBaseSchema.refine(
  (v) => new Date(v.endDate) >= new Date(v.startDate),
  { path: ['endDate'], message: 'Дата окончания должна быть не раньше даты начала' },
);

export const eventUpdateSchema = eventBaseSchema.partial().refine(
  (v) => !v.startDate || !v.endDate || new Date(v.endDate) >= new Date(v.startDate),
  { path: ['endDate'], message: 'Дата окончания должна быть не раньше даты начала' },
);

export const participationCreateSchema = z.object({
  personId: z.string().min(1),
  paymentStatus: paymentStatusSchema.default('UNPAID'),
  prepaidAmount: optionalDecimal,
  totalDue: optionalDecimal,
  notes: optionalString,
});

export const participationUpdateSchema = participationCreateSchema.partial();

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1),
  scope: z.enum(['all', 'people', 'events']).default('all'),
});

export const dateRangeSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine(({ from, to }) => !from || !to || new Date(from) <= new Date(to), {
    path: ['to'],
    message: 'Дата "по" не может быть раньше даты "с"',
  });

export type PersonCreateInput = z.infer<typeof personCreateSchema>;
export type PersonUpdateInput = z.infer<typeof personUpdateSchema>;
export type EventCreateInput = z.infer<typeof eventCreateSchema>;
export type EventUpdateInput = z.infer<typeof eventUpdateSchema>;
export type ParticipationCreateInput = z.infer<typeof participationCreateSchema>;
export type ParticipationUpdateInput = z.infer<typeof participationUpdateSchema>;
