import { join } from 'node:path';
import { z } from 'zod';
import { dataDirectory } from '@/lib/storage/paths';
import { atomicJson, readProtectedJson } from '@/lib/storage/atomic-files';

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;
export const sessionSettingsSchema = z.object({
  idleTimeoutMinutes: z.number().int().min(1).max(1440).nullable(),
}).strict();
const storedSchema = sessionSettingsSchema.extend({ version: z.literal(1) }).strict();
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;

export function securitySettingsPath(): string { return join(dataDirectory(), 'security-settings.json'); }

export function readSessionSettings(): SessionSettings {
  try {
    const { idleTimeoutMinutes } = storedSchema.parse(readProtectedJson(securitySettingsPath()));
    return { idleTimeoutMinutes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES };
    throw error;
  }
}

export function writeSessionSettings(settings: SessionSettings): SessionSettings {
  const parsed = sessionSettingsSchema.parse(settings);
  atomicJson(securitySettingsPath(), { version: 1, ...parsed });
  return parsed;
}
