import { importOwner, importResponse, boundedBody } from '@/lib/batch-import/http';
import { jobs, jobView } from '@/lib/batch-import/jobs';
import { ImportError, LIMITS } from '@/lib/batch-import/limits';
import { parseFiles } from '@/lib/batch-import/parse';
import { withAuthOperation } from '@/lib/auth/mutex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const owner = await importOwner(request);
    return await jobs.parse(async () => {
      const contentType = request.headers.get('content-type') ?? '';
      if (!contentType.startsWith('multipart/form-data')) throw new ImportError('CONTENT_TYPE', 'Отправьте файлы как multipart/form-data.');
      const body = await boundedBody(request, LIMITS.uploadBytes + 1024 * 1024);
      const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData();
      const entries = form.getAll('files');
      if (!entries.length || entries.length > LIMITS.files || entries.some((f) => typeof f === 'string')) throw new ImportError('FILE_COUNT', 'Выберите от 1 до 12 файлов DOCX/XLSX.');
      const files = entries as File[];
      if (files.some((f) => f.size > LIMITS.fileBytes) || files.reduce((n, f) => n + f.size, 0) > LIMITS.uploadBytes) throw new ImportError('UPLOAD_LIMIT', 'Предел: 10 МБ на файл и 30 МБ на пакет.', 413);
      const buffers = [];
      for (const file of files) buffers.push({ name: file.name.slice(0, 250), buffer: Buffer.from(await file.arrayBuffer()) });
      const tables = await parseFiles(buffers);
      return withAuthOperation(async () => {
        if (await importOwner(request) !== owner) throw new ImportError('UNAUTHORIZED', 'Вход изменился. Выберите файлы заново.', 401);
        return Response.json(jobView(jobs.create(owner, tables)), { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
      });
    });
  } catch (error) { return importResponse(error); }
}
