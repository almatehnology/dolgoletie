import type { ReactNode } from 'react';
import { AppNavbar } from '@/components/app-navbar';
import { SearchModal } from '@/components/search-modal';
import { SessionActivityMonitor } from '@/components/session-activity-monitor';
import { requireUser } from '@/lib/auth/guards';
import { redirect } from 'next/navigation';

export default async function AppLayout({ children }: { children: ReactNode }) {
  try { await requireUser(); }
  catch (error) {
    if (error instanceof Response && [401, 403, 423].includes(error.status)) redirect('/login');
    throw error;
  }
  return (
    <div className="flex min-h-screen flex-col">
      <SessionActivityMonitor role="user" />
      <AppNavbar />
        <main className="w-full flex-1 px-4 ">{children}</main>
      <SearchModal />
    </div>
  );
}
