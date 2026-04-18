'use client';

import { Tabs } from '@heroui/react';
import type { Key, ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  badge?: number | string;
  content: ReactNode;
}

interface TabNavProps {
  items: TabItem[];
  defaultSelectedKey?: string;
  onSelectionChange?: (key: Key) => void;
}

/**
 * Единый компонент табов в стиле «pill» на тёмной подложке.
 * Активный таб получает белую карточку с тенью, бейдж справа.
 */
export function TabNav({ items, defaultSelectedKey, onSelectionChange }: TabNavProps) {
  return (
    <Tabs
      orientation="horizontal"
      defaultSelectedKey={defaultSelectedKey ?? items[0]?.id}
      onSelectionChange={onSelectionChange}
    >
      <Tabs.List
        aria-label="Разделы"
        className="!inline-flex !w-auto flex-row flex-nowrap items-center gap-1 overflow-x-auto rounded-xl border border-default-200 !bg-default-100/70 p-1.5"
      >
        {items.map((it) => (
          <Tabs.Tab
            key={it.id}
            id={it.id}
            className={[
              'group !h-auto !w-auto shrink-0 cursor-pointer !justify-start gap-2 rounded-lg px-5 py-2.5 text-[15px] font-medium outline-none transition',
              'text-default-600',
              'data-[hovered=true]:text-foreground',
              'data-[selected=true]:!bg-white data-[selected=true]:text-foreground data-[selected=true]:shadow-sm data-[selected=true]:ring-1 data-[selected=true]:ring-default-200',
              'data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-primary/30',
            ].join(' ')}
          >
            <span className="whitespace-nowrap">{it.label}</span>
            {it.badge !== undefined && it.badge !== '' ? (
              <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-default-200 px-2 py-0.5 text-xs font-semibold text-default-700 group-data-[selected=true]:bg-primary/10 group-data-[selected=true]:text-primary">
                {it.badge}
              </span>
            ) : null}
          </Tabs.Tab>
        ))}
      </Tabs.List>

      {items.map((it) => (
        <Tabs.Panel key={it.id} id={it.id} className="pt-6 outline-none">
          {it.content}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
