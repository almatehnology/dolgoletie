import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { handlePrismaError } from '@/lib/api-helpers';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const restored = await prisma.person.update({
      where: { id },
      data: { deletedAt: null },
    });
    return NextResponse.json(restored);
  } catch (err) {
    return handlePrismaError(err);
  }
}
