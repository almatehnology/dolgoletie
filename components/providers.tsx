'use client';

import { I18nProvider, RouterProvider } from '@heroui/react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { ReduxProvider } from '@/lib/store/provider';

declare module 'react-aria-components' {
  interface RouterConfig {
    href: string;
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <ReduxProvider>
      <I18nProvider locale="ru-RU">
        <RouterProvider navigate={(href) => router.push(href)}>{children}</RouterProvider>
      </I18nProvider>
    </ReduxProvider>
  );
}
