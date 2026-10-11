import { requireUser } from '@/lib/auth/guards';
import { NextResponse, type NextRequest } from 'next/server';
import { searchEvents, searchPeople } from '@/lib/search';

export async function GET(req: NextRequest) {
  try { await requireUser(); } catch (error) { if (error instanceof Response) return error; throw error; }
  const url = req.nextUrl;
  const q = url.searchParams.get('q')?.trim() ?? '';
  const scope = (url.searchParams.get('scope') ?? 'all') as 'all' | 'people' | 'events';
  if (!q) return NextResponse.json({ people: [], events: [] });

  const [people, events] = await Promise.all([
    scope === 'events' ? Promise.resolve([]) : searchPeople(q, 20),
    scope === 'people' ? Promise.resolve([]) : searchEvents(q, 20),
  ]);

  return NextResponse.json({ people, events });
}

export const dynamic = 'force-dynamic';
