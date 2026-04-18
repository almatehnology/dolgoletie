'use client';

import { Button } from '@heroui/react';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/store/api';
import { useAppDispatch } from '@/lib/store/hooks';

interface Props {
  endpoint: '/api/people/import' | '/api/events/import';
  successRedirect: (id: string) => string;
  entityField: 'person' | 'event';
  invalidate: ('People' | 'Person' | 'Events' | 'Event' | 'Search')[];
  label?: string;
}

export function ImportJsonButton({ endpoint, successRedirect, entityField, invalidate, label }: Props) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const text = await file.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        setError('Это не валидный JSON');
        return;
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? 'Не удалось импортировать');
        return;
      }
      dispatch(api.util.invalidateTags(invalidate));
      const id = data?.[entityField]?.id;
      if (id) router.push(successRedirect(id));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <Button variant="outline" isDisabled={busy} onPress={() => inputRef.current?.click()}>
        {busy ? 'Импорт…' : (label ?? 'Импорт JSON')}
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
