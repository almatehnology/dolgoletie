import { z } from 'zod';

export const passwordHashSchema = z.string().max(1024)
  .regex(/^\$argon2id\$v=19\$(?:[mtp]=[1-9]\d*,){2}[mtp]=[1-9]\d*\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/)
  .refine(value => {
    const entries = value.split('$')[3].split(',').map(part => part.split('='));
    const p = Object.fromEntries(entries.map(([key, value]) => [key, Number(value)]));
    return new Set(entries.map(([key]) => key)).size === 3 &&
      p.m >= 8192 && p.m <= 262144 && p.t >= 1 && p.t <= 10 && p.p >= 1 && p.p <= 8;
  });
export const primaryAccountSchema = z.object({
  id: z.string().min(1).max(128),
  username: z.string().min(1).max(80).refine(value => value.normalize('NFKC').trim().toLowerCase() !== 'admin'),
  passwordHash: passwordHashSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
}).strict();
export const authMetadataSchema = z.object({
  version: z.literal(1),
  admin: z.object({ id: z.string().min(1).max(128), username: z.literal('admin'), passwordHash: passwordHashSchema }).strict().optional(),
  primary: primaryAccountSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.primary && (!value.admin || value.primary.id === value.admin.id)) context.addIssue({ code: 'custom', message: 'Invalid account identities' });
});
