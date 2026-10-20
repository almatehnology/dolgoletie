import { z } from 'zod';

export const archiveRequestSchema = z.object({
  entity: z.enum(['people', 'events']),
  action: z.enum(['restore', 'delete']),
  ids: z.array(z.string().trim().min(1).max(100)).min(1).max(200)
    .refine((ids) => new Set(ids).size === ids.length, 'Записи не должны повторяться'),
  confirm: z.literal(true),
}).strict();

export type ArchiveRequest = z.infer<typeof archiveRequestSchema>;
export type ArchiveResult = Pick<ArchiveRequest, 'entity' | 'action' | 'ids'> & { count: number };

export class ArchiveConflict extends Error {
  constructor() {
    super('Часть выбранных записей уже изменена или отсутствует. Обновите архив и выберите записи заново. Ничего не изменено.');
  }
}
