'use client';

import { Button } from '@heroui/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAppDispatch } from '@/lib/store/hooks';
import { openSearchModal } from '@/lib/store/ui-slice';

const links: { href: string; label: string }[] = [
  { href: '/', label: 'Главная' },
  { href: '/people', label: 'Люди' },
  { href: '/events', label: 'Мероприятия' },
  { href: '/archive', label: 'Архив' },
  { href: '/data', label: 'База данных' },
];

export function AppNavbar() {
  const pathname = usePathname();
  const router = useRouter();
  const dispatch = useAppDispatch();

  async function onLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 border-b border-default-200 bg-background/80 backdrop-blur">
      <div className="flex h-14 w-full items-center gap-4 px-5">
        <Link href="/" className="font-semibold">
          Долголетие
        </Link>
        <nav className="hidden flex-1 items-center gap-1 md:flex">
          {links.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={[
                  'rounded-md px-3 py-1.5 text-sm transition',
                  active
                    ? 'bg-default-100 font-medium text-foreground'
                    : 'text-default-500 hover:text-foreground',
                ].join(' ')}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" onPress={() => dispatch(openSearchModal())}>
            Поиск ⌘K
          </Button>
          <Button size="sm" variant="ghost" onPress={onLogout}>
            Выход
          </Button>
        </div>
      </div>
    </header>
  );
}
