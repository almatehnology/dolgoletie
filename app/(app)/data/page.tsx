'use client';
import Link from 'next/link';

import { Button, Card } from '@heroui/react';
import { useRef, useState } from 'react';
import { Field } from '@/components/form-field';
import { api } from '@/lib/store/api';
import { useAppDispatch } from '@/lib/store/hooks';
import { saveLocalFile } from '@/lib/desktop-files';
import { safeDownloadName } from '@/lib/file-names';

type Scope = 'full' | 'people' | 'events';
type Mode = 'merge' | 'replace';

const RESET_CONFIRM = 'ОЧИСТИТЬ';

export default function DataPage() {
  const dispatch = useAppDispatch();
  const [scope, setScope] = useState<Scope>('full');
  const [mode, setMode] = useState<Mode>('merge');
  const [dryRun, setDryRun] = useState(true);
  const [backupPassword, setBackupPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const [resetWord, setResetWord] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function downloadExport() {
    setExporting(true); setError(null);
    try {
      const response = await fetch(`/api/export?scope=${scope}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Не удалось создать резервную копию. Проверьте вход и вложения.');
      const extension = response.headers.get('content-type')?.includes('zip') ? 'zip' : 'tdbbackup';
      const encoded = response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const filename = safeDownloadName(encoded ? decodeURIComponent(encoded) : 'dolgoletie-backup', extension);
      await saveLocalFile(await response.blob(), filename);
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось сохранить копию'); }
    finally { setExporting(false); }
  }

  async function runImport() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Выберите файл резервной копии ZIP или TDBBACKUP');
      return;
    }
    if (!dryRun && !confirm('Записи из резервной копии будут добавлены или заменены согласно выбранному режиму. Подтвердить восстановление?')) return;
    setError(null);
    setResult(null);
    setImporting(true);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('mode', mode);
      body.append('dryRun', String(dryRun));
      if (backupPassword) body.append('password', backupPassword);
      const res = await fetch('/api/import', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? 'Не удалось импортировать');
      } else {
        setResult(data);
        dispatch(api.util.invalidateTags(['People', 'Person', 'Events', 'Event', 'Search']));
      }
    } catch { setError('Не удалось восстановить копию. Проверьте файл, пароль и вход.'); }
    finally {
      setImporting(false);
      setBackupPassword('');
    }
  }

  async function runReset() {
    if (resetWord !== RESET_CONFIRM) {
      setResetMsg({ kind: 'err', text: `Введите слово ${RESET_CONFIRM} для подтверждения` });
      return;
    }
    if (!confirm('Все карточки и мероприятия будут удалены. Удаления будут предложены другим ноутбукам при синхронизации. Продолжить?')) {
      return;
    }
    setResetting(true);
    setResetMsg(null);
    try {
      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: resetWord }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResetMsg({ kind: 'err', text: data?.error?.message ?? 'Не удалось очистить' });
      } else {
        setResetWord('');
        setResetMsg({ kind: 'ok', text: 'База полностью очищена.' });
        dispatch(api.util.invalidateTags(['People', 'Person', 'Events', 'Event', 'Search']));
      }
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">База данных</h1>
      <div className="flex flex-wrap gap-3"><Link href="/people/import" className="text-primary hover:underline">Пакетная загрузка DOCX / XLSX</Link><Link href="/sync" className="text-primary hover:underline">Синхронизация через файл</Link></div>
      <p className="-mt-4 text-sm text-default-500">
        Экспорт, импорт и полная очистка.
      </p>

      <Card>
        <Card.Header>
          <Card.Title>Резервная копия</Card.Title>
          <Card.Description>Сохраняет данные и вложения. Если шифрование включено, копия защищается текущим паролем. Для обмена изменениями между ноутбуками используйте синхронизацию.</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3 p-6">
          <div className="flex flex-wrap gap-2">
            {(['full', 'people', 'events'] as Scope[]).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={scope === s ? 'primary' : 'outline'}
                onPress={() => setScope(s)}
              >
                {s === 'full' ? 'Полный' : s === 'people' ? 'Только люди' : 'Только мероприятия'}
              </Button>
            ))}
          </div>
          <Button variant="primary" isDisabled={exporting} onPress={downloadExport}>
            {exporting ? 'Подготовка…' : 'Сохранить копию'}
          </Button>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Восстановление из резервной копии</Card.Title>
          <Card.Description>
            Выберите ранее созданный ZIP или TDBBACKUP. Пробный запуск покажет количество изменений. Восстановление заменяет совпавшие записи; для проверки каждого поля используйте пакетную загрузку или синхронизацию.
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3 p-6">
          <div>
            <input ref={fileRef} type="file" accept=".zip,.tdbbackup" />
          </div>
          <Field label="Пароль копии (если она зашифрована)" type="password" value={backupPassword} onChange={setBackupPassword} autoComplete="off" />
          <div>
            <div className="mb-1 text-sm font-medium">Режим</div>
            <div className="flex gap-2">
              {(['merge', 'replace'] as Mode[]).map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={mode === m ? 'primary' : 'outline'}
                  onPress={() => setMode(m)}
                >
                  {m === 'merge' ? 'Объединить (merge)' : 'Заменить (replace)'}
                </Button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            Пробный запуск (показать план без записи)
          </label>
          <Button variant="primary" isDisabled={importing} onPress={runImport}>
            {importing ? 'Импорт…' : dryRun ? 'Показать план' : 'Запустить импорт'}
          </Button>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          {result ? (
            <pre className="overflow-auto rounded-lg border border-default-200 bg-default-50 p-3 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          ) : null}
        </Card.Content>
      </Card>

      <Card className="border-danger/40">
        <Card.Header>
          <Card.Title className="text-danger">Опасная зона: полная очистка базы</Card.Title>
          <Card.Description>
            Удаляет всех людей, мероприятия, участия, экскурсии и сканы паспортов с диска.
            Действие необратимо — сделайте экспорт заранее.
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3 p-6">
          <Field
            label={`Подтвердите: введите слово ${RESET_CONFIRM}`}
            value={resetWord}
            onChange={setResetWord}
            placeholder={RESET_CONFIRM}
            className="max-w-md"
          />
          <div>
            <Button
              variant="danger"
              isDisabled={resetting || resetWord !== RESET_CONFIRM}
              onPress={runReset}
            >
              {resetting ? 'Очистка…' : 'Полностью очистить базу'}
            </Button>
          </div>
          {resetMsg ? (
            <p className={resetMsg.kind === 'ok' ? 'text-sm text-success' : 'text-sm text-danger'}>
              {resetMsg.text}
            </p>
          ) : null}
        </Card.Content>
      </Card>
    </div>
  );
}
