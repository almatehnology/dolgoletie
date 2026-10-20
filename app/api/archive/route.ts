import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/guards';
import { withAuthOperation } from '@/lib/auth/mutex';
import { apiError, handlePrismaError, parseJson } from '@/lib/api-helpers';
import { ArchiveConflict, archiveRequestSchema } from '@/lib/archive/model';
import { applyArchiveAction } from '@/lib/archive/service';

export async function POST(req: Request) {
  try {
    return await withAuthOperation(async () => {
      await requireUser();
      const parsed = await parseJson(req, archiveRequestSchema);
      if (!parsed.ok) return parsed.response;
      return NextResponse.json(await applyArchiveAction(parsed.data));
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ArchiveConflict) return apiError('ARCHIVE_CONFLICT', error.message, 409);
    return handlePrismaError(error);
  }
}

export const dynamic = 'force-dynamic';
