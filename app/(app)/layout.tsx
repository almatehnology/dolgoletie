import type { ReactNode } from 'react';
import { AppNavbar } from '@/components/app-navbar';
import { SearchModal } from '@/components/search-modal';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppNavbar />
        <main className="w-full flex-1 px-4 ">{children}</main>
      <SearchModal />
    </div>
  );
}
