import { NextResponse, type NextRequest } from 'next/server';
import { apiError, handlePrismaError, parseJson } from '@/lib/api-helpers';
import { importPerson, personEnvelopeSchema } from '@/lib/object-export';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const parsed = await parseJson(req, personEnvelopeSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const { action, record } = await importPerson(parsed.data);
    return NextResponse.json({ action, person: record }, { status: action === 'created' ? 201 : 200 });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Некорректные')) {
      return apiError('VALIDATION', err.message, 400);
    }
    return handlePrismaError(err);
  }
}
