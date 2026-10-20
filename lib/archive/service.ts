import { prisma } from '@/lib/db';
import { ArchiveConflict, archiveRequestSchema, type ArchiveRequest, type ArchiveResult } from './model';

export async function applyArchiveAction(input: ArchiveRequest): Promise<ArchiveResult> {
  const request = archiveRequestSchema.parse(input);
  const { entity, action, ids } = request;
  // Use the journal-aware wrapper: scalar changes, cascaded children and their
  // tombstones commit together. Keep journal snapshots and immutable originals
  // available for future sync exports; this is not a secure purge.
  return prisma.$transaction(async (tx) => {
    const where = { id: { in: ids }, deletedAt: { not: null } };
    const count = entity === 'people'
      ? await tx.person.count({ where })
      : await tx.event.count({ where });
    if (count !== ids.length) throw new ArchiveConflict();

    const result = entity === 'people'
      ? action === 'restore'
        ? await tx.person.updateMany({ where, data: { deletedAt: null } })
        : await tx.person.deleteMany({ where })
      : action === 'restore'
        ? await tx.event.updateMany({ where, data: { deletedAt: null } })
        : await tx.event.deleteMany({ where });
    if (result.count !== ids.length) throw new ArchiveConflict();
    return { entity, action, ids, count: result.count };
  });
}
