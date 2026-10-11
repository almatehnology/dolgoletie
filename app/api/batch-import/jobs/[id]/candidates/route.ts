import { z } from 'zod';
import { prisma } from '@/lib/db';
import { importOwner, importResponse, requestJson, revisionSchema } from '@/lib/batch-import/http';
import { readPeople } from '@/lib/batch-import/database';
import { jobs, jobView } from '@/lib/batch-import/jobs';
import { ImportError } from '@/lib/batch-import/limits';
import { buildPlan } from '@/lib/batch-import/plan';
import { nameKey } from '@/lib/batch-import/normalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const owner = await importOwner(request);
    jobs.get((await context.params).id, owner);
    const q = nameKey(new URL(request.url).searchParams.get('q') ?? '');
    if (q.length < 2 || q.length > 200) return Response.json({ items: [], hasMore: false });
    const tokens = q.split(' ');
    const matches = (await readPeople()).filter((p) => {
      const haystack = nameKey([p.values.lastName, p.values.firstName, p.values.middleName, p.values.phone, p.values.passportNumber, p.values.birthDate].filter(Boolean).join(' '));
      return tokens.every((part) => haystack.includes(part));
    });
    return Response.json({ items: matches.slice(0, 50), hasMore: matches.length > 50 }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return importResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const owner = await importOwner(request);
    const data = z.object({ revision: revisionSchema, personId: z.string().min(1).max(100) }).strict().parse(await requestJson(request));
    return await jobs.locked((await context.params).id, owner, async (job) => {
      if (job.result || job.revision !== data.revision) throw new ImportError('PLAN_VERSION', 'Обновите предварительный просмотр.', 409);
      const found = await prisma.person.findUnique({ where: { id: data.personId } });
      if (!found) throw new ImportError('PERSON_NOT_FOUND', 'Карточка больше не существует.', 404);
      const next = structuredClone(job);
      if (!next.manualCandidateIds.includes(found.id)) next.manualCandidateIds.push(found.id);
      if (next.manualCandidateIds.length > 100) throw new ImportError('CANDIDATE_LIMIT', 'Добавлено более 100 ручных кандидатов.');
      next.revision++;
      if (next.plan) next.plan = buildPlan(next, await readPeople());
      jobs.checkSize(next); Object.assign(job, next);
      return Response.json(jobView(job));
    });
  } catch (error) { return importResponse(error); }
}
