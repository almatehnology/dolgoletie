'use client';
import { SyncAccessCompletion } from '@/components/sync-access-completion';

import { Button, Card } from '@heroui/react';
import { useState } from 'react';
import { Field } from '@/components/form-field';

type AdminStatus = { primary: { username: string; version: number } | null; encryptionEnabled: boolean };
type OperationResult = { token?: string; recoveryCode?: string };

async function adminRequest(path: string, body: object): Promise<OperationResult> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message ?? (response.status === 404 ? 'Эта операция пока недоступна' : 'Не удалось выполнить операцию'));
  return result ?? {};
}

function RecoveryCode({ code }: { code: string }) {
  return <div className="flex flex-col gap-2 rounded-md border border-warning p-4" role="status">
    <p className="font-medium">Код восстановления</p>
    <code className="select-all break-all rounded bg-default-100 p-3 text-base">{code}</code>
    <p className="text-sm">Сохраните код отдельно от базы, например на бумаге. Он понадобится, если пароль будет утрачен.</p>
  </div>;
}

function ProofField({ proof, setProof, recovery, setRecovery, encrypted, busy }: {
  proof: string; setProof(value: string): void; recovery: boolean; setRecovery(value: boolean): void; encrypted: boolean; busy: boolean;
}) {
  return <>
    {encrypted ? <fieldset className="flex flex-wrap gap-4 text-sm" disabled={busy}>
      <legend className="mb-2 font-medium">Подтверждение доступа</legend>
      <label className="flex items-center gap-2"><input type="radio" checked={!recovery} onChange={() => { setRecovery(false); setProof(''); }} />Текущий пароль</label>
      <label className="flex items-center gap-2"><input type="radio" checked={recovery} onChange={() => { setRecovery(true); setProof(''); }} />Код восстановления</label>
    </fieldset> : null}
    <Field label={recovery ? 'Код восстановления' : 'Текущий пароль основного пользователя'} value={proof} onChange={setProof} type="password" autoComplete={recovery ? 'off' : 'current-password'} isRequired />
  </>;
}

function CreateUser({ onCreated }: { onCreated(): Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmation) { setError('Пароли не совпадают'); return; }
    setBusy(true); setError(null);
    try { await adminRequest('/api/admin/user', { username, password }); await onCreated(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Не удалось создать пользователя'); }
    finally { setBusy(false); setPassword(''); setConfirmation(''); }
  }

  return <form onSubmit={submit} className="flex flex-col gap-4">
    <p className="text-sm text-default-600">Создайте единственную основную учётную запись для просмотра и изменения базы.</p>
    <Field label="Имя пользователя" value={username} onChange={setUsername} autoComplete="username" isRequired />
    <Field label="Пароль (не менее 12 символов)" value={password} onChange={setPassword} type="password" autoComplete="new-password" isRequired />
    <Field label="Повторите пароль" value={confirmation} onChange={setConfirmation} type="password" autoComplete="new-password" isRequired />
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <Button type="submit" variant="primary" isDisabled={busy || !username.trim() || password.length < 12 || !confirmation}>{busy ? 'Создание…' : 'Создать пользователя'}</Button>
  </form>;
}

function PasswordForm({ encrypted, onChanged }: { encrypted: boolean; onChanged(): Promise<void> }) {
  const [proof, setProof] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmation) { setError('Пароли не совпадают'); return; }
    setBusy(true); setError(null); setDone(false); setCode(null);
    try {
      const result = await adminRequest('/api/admin/user-password', { proof, password, recovery: encrypted && recovery });
      setCode(result.recoveryCode ?? null); setDone(true); await onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось изменить пароль'); }
    finally { setBusy(false); setProof(''); setPassword(''); setConfirmation(''); }
  }

  return <form onSubmit={submit} className="flex flex-col gap-4">
    <ProofField proof={proof} setProof={setProof} recovery={encrypted && recovery} setRecovery={setRecovery} encrypted={encrypted} busy={busy} />
    <Field label="Новый пароль (не менее 12 символов)" value={password} onChange={setPassword} type="password" autoComplete="new-password" isRequired />
    <Field label="Повторите новый пароль" value={confirmation} onChange={setConfirmation} type="password" autoComplete="new-password" isRequired />
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    {done ? <p role="status" className="text-sm">Пароль изменён. Основному пользователю нужно войти снова.</p> : null}
    {code ? <><RecoveryCode code={code} /><Button variant="secondary" onPress={() => setCode(null)}>Код сохранён</Button></> : null}
    <Button type="submit" variant="primary" isDisabled={busy || !proof || password.length < 12 || !confirmation || Boolean(code)}>{busy ? 'Изменение…' : recovery && encrypted ? 'Восстановить доступ' : 'Изменить пароль'}</Button>
  </form>;
}

function EncryptionForm({ enabled, onChanged }: { enabled: boolean; onChanged(): Promise<void> }) {
  const [proof, setProof] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [prepared, setPrepared] = useState<{ token: string; recoveryCode: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setDone(false);
    try {
      if (enabled) {
        await adminRequest('/api/admin/encryption', { action: 'disable', proof, recovery });
      } else if (!prepared) {
        const result = await adminRequest('/api/admin/encryption', { action: 'prepare', proof });
        if (!result.token || !result.recoveryCode) throw new Error('Не удалось подготовить код восстановления');
        setPrepared({ token: result.token, recoveryCode: result.recoveryCode });
        setConfirmed(false);
        return;
      } else {
        if (!confirmed) throw new Error('Сначала сохраните код восстановления');
        await adminRequest('/api/admin/encryption', { action: 'enable', proof, token: prepared.token, confirmed: true });
      }
      setProof(''); setPrepared(null); setConfirmed(false); setDone(true); await onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось изменить режим шифрования');
      // A failed conversion needs a new preparation token and recovery code.
      setPrepared(null); setConfirmed(false); setProof('');
    } finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="flex flex-col gap-4">
    <p className="text-sm">Шифрование {enabled ? 'включено' : 'выключено'}. Изменение режима применяется к базе и всем вложениям.</p>
    {!prepared ? <ProofField proof={proof} setProof={setProof} recovery={enabled && recovery} setRecovery={setRecovery} encrypted={enabled} busy={busy} /> : <>
      <RecoveryCode code={prepared.recoveryCode} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} disabled={busy} />Я сохранил код восстановления отдельно от базы</label>
      <Button variant="secondary" isDisabled={busy} onPress={() => { setPrepared(null); setConfirmed(false); setProof(''); }}>Отменить подготовку</Button>
    </>}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    {done ? <p role="status" className="text-sm">Режим хранения изменён. Для работы с базой войдите под основным пользователем.</p> : null}
    <Button type="submit" variant="primary" isDisabled={busy || !proof || Boolean(prepared && !confirmed)}>{busy ? 'Обработка…' : enabled ? 'Отключить шифрование' : prepared ? 'Включить шифрование' : 'Подготовить включение'}</Button>
  </form>;
}

export function AdminPanel({ initialStatus }: { initialStatus: AdminStatus }) {
  const [status, setStatus] = useState(initialStatus);
  async function refreshStatus() {
    const response = await fetch('/api/admin/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? 'Не удалось обновить состояние');
    setStatus(data);
  }
  return <div className="flex flex-col gap-6">
    <div><h1 className="text-2xl font-semibold">Управление доступом</h1><p className="mt-2 text-sm text-default-600">Admin управляет учётной записью и защитой хранения. Для работы с записями войдите под основным пользователем.</p></div>
    <Card><Card.Header><Card.Title>Основной пользователь</Card.Title></Card.Header><Card.Content className="p-6">
      {status.primary ? <p>Пользователь: <strong>{status.primary.username}</strong>. Версия доступа: {status.primary.version}.</p> : <CreateUser onCreated={refreshStatus} />}
    </Card.Content></Card>
    {status.primary ? <>
      <SyncAccessCompletion encrypted={status.encryptionEnabled} onCompleted={refreshStatus} />
      <Card><Card.Header><Card.Title>Пароль и восстановление</Card.Title></Card.Header><Card.Content className="p-6"><PasswordForm encrypted={status.encryptionEnabled} onChanged={refreshStatus} /></Card.Content></Card>
      <Card><Card.Header><Card.Title>Шифрование базы</Card.Title></Card.Header><Card.Content className="p-6"><EncryptionForm enabled={status.encryptionEnabled} onChanged={refreshStatus} /></Card.Content></Card>
    </> : null}
  </div>;
}
