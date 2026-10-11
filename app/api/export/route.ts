import { requireUser } from '@/lib/auth/guards';
import { type NextRequest } from 'next/server';
import { buildExportZip, type ExportScope } from '@/lib/export';
import { Readable } from 'node:stream';
import { withAuthOperation } from '@/lib/auth/mutex';
import { apiError } from '@/lib/api-helpers';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    return await withAuthOperation(async () => {
      await requireUser();
      const scopeParam = req.nextUrl.searchParams.get('scope') ?? 'full';
      const scope: ExportScope = scopeParam === 'people' || scopeParam === 'events' ? scopeParam : 'full';
      const { stream, filename, contentType } = await buildExportZip(scope);

      return new Response(Readable.toWeb(stream) as ReadableStream, {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'private, no-store',
        },
      });
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError('EXPORT_FAILED', 'Не удалось создать резервную копию. Проверьте наличие и целостность вложений.', 500);
  }
}
