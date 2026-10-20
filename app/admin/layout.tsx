import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AppNavbar } from '@/components/app-navbar';
import { requireAdmin } from '@/lib/auth/guards';
import { SessionActivityMonitor } from '@/components/session-activity-monitor';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  try { await requireAdmin(); }
  catch (error) {
    if (error instanceof Response && (error.status === 401 || error.status === 403)) redirect('/login?role=admin');
    throw error;
  }
  return <div className="flex min-h-screen flex-col"><SessionActivityMonitor role="admin" /><AppNavbar role="admin" /><main className="mx-auto w-full max-w-3xl flex-1 p-4 md:p-6">{children}</main></div>;
}
