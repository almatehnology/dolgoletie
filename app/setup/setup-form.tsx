'use client';

import { Button, Card } from '@heroui/react';
import { useState } from 'react';
import { Field } from '@/components/form-field';

export function SetupForm({ legacyRequired, canSetup }: { legacyRequired: boolean; canSetup: boolean }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [legacyPassword, setLegacyPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmation) { setError('Пароли не совпадают'); return; }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, ...(legacyRequired ? { legacyPassword } : {}) }) });
      const data = await response.json();
      if (!response.ok) { setError(data?.error?.message ?? 'Не удалось создать admin'); return; }
      window.location.replace('/login?role=admin');
    } catch { setError('Не удалось связаться с приложением'); }
    finally { setBusy(false); setPassword(''); setConfirmation(''); setLegacyPassword(''); }
  }

  return <Card className="w-full max-w-md">
    <Card.Header><Card.Title>Первичная настройка</Card.Title><Card.Description>Создайте единственного администратора этой установки.</Card.Description></Card.Header>
    <Card.Content className="p-6">
      <p className="mb-4 text-sm text-default-600">Имя администратора — admin. После входа создайте основного пользователя для работы с базой. Существующие записи сохраняются.</p>
      {!canSetup ? <p role="alert" className="text-sm text-danger">Обнаружена существующая база. Для подтверждения переноса требуется её прежний APP_PASSWORD. Обратитесь к владельцу установки.</p> : <form onSubmit={submit} className="flex flex-col gap-4">
        {legacyRequired ? <Field label="Прежний пароль установки" value={legacyPassword} onChange={setLegacyPassword} type="password" autoComplete="current-password" isRequired /> : null}
        <Field label="Новый пароль admin (не менее 12 символов)" value={password} onChange={setPassword} type="password" autoComplete="new-password" isRequired />
        <Field label="Повторите пароль admin" value={confirmation} onChange={setConfirmation} type="password" autoComplete="new-password" isRequired />
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <Button type="submit" variant="primary" isDisabled={busy || password.length < 12 || !confirmation || (legacyRequired && !legacyPassword)}>{busy ? 'Создание…' : 'Создать admin'}</Button>
      </form>}
    </Card.Content>
  </Card>;
}
