'use client';

import { Button, Card } from '@heroui/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Field } from '@/components/form-field';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/';
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? 'Ошибка входа');
        return;
      }
      router.push(next);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <Card.Header>
        <Card.Title>Вход в Долголетие</Card.Title>
        <Card.Description>Введите пароль портала</Card.Description>
      </Card.Header>
      <Card.Content className="p-6">
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <Field label="Пароль" value={password} onChange={setPassword} type="password" isRequired autoFocus autoComplete="current-password" />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button type="submit" variant="primary" isDisabled={!password || loading}>
            {loading ? 'Вход…' : 'Войти'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
