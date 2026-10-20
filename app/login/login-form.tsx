'use client';

import { Button, Card } from '@heroui/react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Field } from '@/components/form-field';
import { useAppStore } from '@/lib/store/hooks';
import { clearClientSession, safeUserDestination, safeAdminDestination } from '@/lib/auth/client';

export function LoginForm() {
  const searchParams = useSearchParams();
  const store = useAppStore();
  const [username, setUsername] = useState(searchParams.get('role') === 'admin' ? 'admin' : '');
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
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      clearClientSession(store);
      if (!res.ok) {
        setError(data?.error?.message ?? 'Ошибка входа');
        return;
      }
      window.location.replace(data.role === 'admin' ? safeAdminDestination(searchParams.get('syncToken')) : safeUserDestination(searchParams.get('next')));
    } catch {
      setError('Не удалось связаться с приложением');
    } finally {
      setPassword('');
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <Card.Header>
        <Card.Title>Вход в Долголетие</Card.Title>
        <Card.Description>Основной пользователь открывает базу. Admin управляет доступом.</Card.Description>
      </Card.Header>
      <Card.Content className="p-6">
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          {searchParams.get('expired') === '1' ? <p role="status" className="text-sm">Сессия завершена. Войдите снова, чтобы продолжить.</p> : null}
          <Field label="Имя пользователя" value={username} onChange={setUsername} isRequired autoFocus autoComplete="username" />
          <Field label="Пароль" value={password} onChange={setPassword} type="password" isRequired autoComplete="current-password" />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button type="submit" variant="primary" isDisabled={!username || !password || loading}>
            {loading ? 'Вход…' : 'Войти'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
