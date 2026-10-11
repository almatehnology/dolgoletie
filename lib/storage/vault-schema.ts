import { z } from 'zod';

const base64 = (bytes: number) => z.string().max(256).refine(value => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === bytes && Buffer.from(value, 'base64').toString('base64') === value);
export const keySlotSchema = z.object({
  salt: base64(16), nonce: base64(12), tag: base64(16), value: base64(32),
  memoryCost: z.literal(65536), timeCost: z.literal(3), parallelism: z.literal(1),
}).strict();
export const generationSchema = z.string().uuid();
export const vaultConfigSchema = z.object({
  format: z.literal(1), enabled: z.boolean(), generation: generationSchema.optional(),
  passwordSlot: keySlotSchema.optional(), recoverySlot: keySlotSchema.optional(),
  accessRevision: z.string().min(1).max(128),
  accessHistory: z.array(z.object({
    id: z.string().min(1).max(128), parents: z.array(z.string().min(1).max(128)).max(2000), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (value.enabled && (!value.passwordSlot || !value.recoverySlot)) context.addIssue({ code: 'custom', message: 'Missing key slots' });
  if (!value.enabled && (value.passwordSlot || value.recoverySlot)) context.addIssue({ code: 'custom', message: 'Unexpected key slots' });
});
