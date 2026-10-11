'use client';
import { useEffect, useState } from 'react';
import { Button, Card } from '@heroui/react';
import { Field } from './form-field';

export function SyncAccessCompletion({ encrypted, onCompleted }: { encrypted: boolean; onCompleted(): Promise<void> }) {
  const [token, setToken] = useState(''), [proof, setProof] = useState(''), [incomingPassword, setIncomingPassword] = useState('');
  const [recovery, setRecovery] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setToken(new URL(window.location.href).searchParams.get('syncToken') ?? ''); }, []);
  if (!token) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMessage(null);
    try {
      const response = await fetch('/api/admin/sync-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, proof, recovery, incomingPassword: incomingPassword || undefined }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? 'Не удалось завершить перенос доступа');
      setMessage('Режим хранения и доступ обновлены. Войдите под пользователем из файла синхронизации.'); await onCompleted();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Операция не выполнена'); }
    finally { setBusy(false); setProof(''); setIncomingPassword(''); }
  }
  return <Card><Card.Header><Card.Title>Завершение синхронизации доступа</Card.Title><Card.Description>Изменения записей подтверждены основным пользователем. Admin завершает смену режима хранения.</Card.Description></Card.Header><Card.Content className="p-6">
    <form onSubmit={submit} className="flex flex-col gap-4">
      {encrypted && <label className="flex gap-2 text-sm"><input type="checkbox" checked={recovery} onChange={e => setRecovery(e.target.checked)} />Использовать ключ восстановления локальной базы</label>}
      <Field label={recovery ? 'Ключ восстановления локальной базы' : 'Текущий пароль локального пользователя'} type="password" value={proof} onChange={setProof} />
      <Field label="Пароль входящего файла, если он зашифрован" type="password" value={incomingPassword} onChange={setIncomingPassword} />
      {message && <p role="status" className="text-sm">{message}</p>}
      <Button type="submit" variant="primary" isDisabled={busy || !proof}>{busy ? 'Преобразование…' : 'Подтвердить режим хранения и доступ'}</Button>
    </form>
  </Card.Content></Card>;
}
