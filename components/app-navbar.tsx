'use client';

import { Button } from '@heroui/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useAppDispatch, useAppStore } from '@/lib/store/hooks';
import { openSearchModal } from '@/lib/store/ui-slice';
import { leaveAccount } from '@/lib/auth/client';

const links: { href: string; label: string }[] = [
  { href: '/', label: 'Главная' },
  { href: '/people', label: 'Люди' },
  { href: '/events', label: 'Мероприятия' },
  { href: '/archive', label: 'Архив' },
  { href: '/data', label: 'База данных' },
];

export function AppNavbar({ role = 'user' }: { role?: 'user' | 'admin' }) {
  const pathname = usePathname();
  const dispatch = useAppDispatch();
  const store = useAppStore();
  const [leaving, setLeaving] = useState(false);

  async function onLogout(destination = '/login') {
    setLeaving(true);
    try { await leaveAccount(store, destination); } catch { /* navigation still clears the local session */ }
  }

  return (
    <header className="sticky top-0 z-40 border-b border-default-200 bg-background/80 backdrop-blur">
      <div className="flex h-14 w-full items-center gap-4 px-5">
        <Link href={role === 'admin' ? '/admin' : '/'} className="font-semibold">
          Долголетие
        </Link>
        <nav className="hidden flex-1 items-center gap-1 md:flex">
          {(role === 'admin' ? [{ href: '/admin', label: 'Управление доступом' }] : links).map((l) => {
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
          {role === 'user' ? <>
            <Button size="sm" variant="secondary" onPress={() => dispatch(openSearchModal())} isDisabled={leaving}>Поиск ⌘K</Button>
            <Button size="sm" variant="ghost" onPress={() => onLogout('/login?role=admin')} isDisabled={leaving}>Admin</Button>
          </> : <Button size="sm" variant="secondary" onPress={() => onLogout('/login')} isDisabled={leaving}>Вход пользователя</Button>}
          <Button size="sm" variant="ghost" onPress={() => onLogout()} isDisabled={leaving}>
            Выход
          </Button>
        </div>
      </div>
    </header>
  );
}
