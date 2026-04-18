import { type NextRequest } from 'next/server';
import { buildExportZip, type ExportScope } from '@/lib/export';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const scopeParam = req.nextUrl.searchParams.get('scope') ?? 'full';
  const scope: ExportScope = scopeParam === 'people' || scopeParam === 'events' ? scopeParam : 'full';
  const { stream, filename } = await buildExportZip(scope);

  return new Response(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
