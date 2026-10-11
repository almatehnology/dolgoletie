'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/store/api';
import { useAppDispatch } from '@/lib/store/hooks';
import type { ApplyResult, Decision, JobView, PersonSnapshot, TableSelection } from '@/lib/batch-import/types';
import { TableMapping } from './table-mapping';
import { ImportPreview, STATUS_LABELS } from './preview';

const SESSION_KEY = 'tdb-batch-import';
const CONFIRMATION_KEY = 'tdb-batch-import-confirmation';
const button = 'rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50';
type Pending = { id: string; version: number };
class RequestError extends Error { constructor(message: string, public code: string) { super(message); } }
async function request<T>(url: string, init?: RequestInit, onDispatched?: () => void): Promise<T> {
  const dispatched = fetch(url, { ...init, cache: 'no-store' });
  onDispatched?.();
  const response = await dispatched;
  if (response.status === 204) return undefined as T;
  let data;
  try { data = await response.json(); }
  catch { throw new RequestError('Сервер не вернул результат. Проверьте вход и повторите запрос.', 'INVALID_RESPONSE'); }
  if (!response.ok) throw new RequestError(data.error?.message ?? 'Не удалось обработать запрос.', data.error?.code ?? 'ERROR');
  return data;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function ImportWizard() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [files, setFiles] = useState<File[]>([]);
  const [job, setJob] = useState<JobView | null>(null);
  const [selections, setSelections] = useState<TableSelection[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [step, setStep] = useState<'files' | 'mapping' | 'preview'>('files');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  function acceptJob(next: JobView) {
    setJob(next); setSelections(next.tables.map((t) => t.selection)); setDecisions(next.decisions); setDirty(false); setConfirmed(false);
    setStep(next.plan ? 'preview' : 'mapping');
    if (next.result) { done(next.result); return; }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: next.id }));
  }
  useEffect(() => {
    let active = true;
    let sent: Pending | null = null, draft: { id: string } | null = null;
    try { const value = JSON.parse(sessionStorage.getItem(CONFIRMATION_KEY) ?? 'null'); if (value && typeof value.id === 'string' && Number.isInteger(value.version) && value.version > 0) sent = value; } catch { /* No saved confirmation. */ }
    try { const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null'); if (value && typeof value.id === 'string') draft = value; } catch { /* No saved draft. */ }
    setPending(sent);
    const id = draft?.id ?? sent?.id;
    if (!id) return;
    setBusy(true);
    request<JobView>(`/api/batch-import/jobs/${id}`).then((next) => { if (active) acceptJob(next); }).catch((err) => { if (active) setError(`${err.message}${sent ? ' Можно запросить сохранённый результат ниже.' : ''}`); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  // Resume the saved draft once per mount; editing a draft must not reload it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function work(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); }
    catch (err) {
      setError((err as Error).message);
      if (err instanceof RequestError && (err.code === 'STALE_PLAN' || err.code === 'PLAN_VERSION') && job) {
        try { acceptJob(await request<JobView>(`/api/batch-import/jobs/${job.id}`)); } catch { /* Keep original error. */ }
      }
    } finally { setBusy(false); }
  }
  function done(value: ApplyResult) {
    setResult(value); setConfirmed(false);
    dispatch(api.util.invalidateTags(['People', 'Person', 'Search'])); router.refresh();
    sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(CONFIRMATION_KEY); setPending(null);
  }
  async function upload() {
    await work(async () => { const body = new FormData(); files.forEach((f) => body.append('files', f)); acceptJob(await request<JobView>('/api/batch-import/jobs', { method: 'POST', body })); });
  }
  async function plan(body: object) {
    if (!job) return;
    await work(async () => acceptJob(await request<JobView>(`/api/batch-import/jobs/${job.id}/plan`, json({ revision: job.revision, ...body }))));
  }
  async function cancel() {
    await work(async () => {
      if (job) {
        try { await request(`/api/batch-import/jobs/${job.id}`, { method: 'DELETE' }); }
        catch (err) { if (!(err instanceof RequestError) || err.code !== 'JOB_NOT_FOUND') throw err; }
      }
      setJob(null); setResult(null); setFiles([]); setStep('files'); setPending(null); setConfirmed(false); sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(CONFIRMATION_KEY);
    });
  }
  async function manualCandidate(groupId: string, person: PersonSnapshot) {
    if (!job || busy) return;
    setBusy(true);
    try {
      const next = await request<JobView>(`/api/batch-import/jobs/${job.id}/candidates`, json({ revision: job.revision, personId: person.id }));
      acceptJob(next);
      setDecisions([...decisions.filter((d) => d.groupId !== groupId), { groupId, action: 'existing', personId: person.id }]);
      setDirty(true);
    } finally { setBusy(false); }
  }
  async function confirmPlan() {
    if (!job?.plan || !confirmed || dirty || busy || job.plan.blocked || !job.plan.ready) return;
    const version = job.plan.version;
    await work(async () => done(await request<ApplyResult>(`/api/batch-import/jobs/${job.id}/apply`, json({ version, confirm: true }), () => {
      const sent = { id: job.id, version };
      sessionStorage.setItem(CONFIRMATION_KEY, JSON.stringify(sent)); setPending(sent);
    })));
  }
  return <div className="flex flex-col gap-5">
    <p className="text-sm text-default-600">1. Файлы → 2. Таблицы и колонки → 3. Проверка → 4. Подтверждение. Пустые ячейки не очищают карточки. Задание действует 30 минут; после перезапуска приложения файлы потребуется выбрать снова.</p>
    {error && <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
    {busy && <p role="status" className="text-sm">Обработка…</p>}
    {result ? <section className="rounded-lg border border-success/30 p-4"><h2 className="text-lg font-medium">Импорт сохранён</h2><p className="my-3">Создано: {result.created}; изменено: {result.updated}; без изменений: {result.unchanged}; пропущено строк: {result.skipped}; восстановлено: {result.restored}.</p><div className="flex flex-wrap gap-3">{result.people.map((p) => <Link className="text-primary hover:underline" key={p.id} href={`/people/${p.id}`}>Карточка · {p.action === 'created' ? 'создана' : p.action === 'updated' ? 'изменена' : 'без изменений'}</Link>)}</div><button type="button" className={`${button} mt-4`} disabled={busy} onClick={cancel}>Новый импорт</button></section> : <>
      {step === 'files' && <section className="rounded-lg border border-default-200 p-4"><label className="flex flex-col gap-2 font-medium">Выберите DOCX/XLSX<input type="file" multiple accept=".docx,.xlsx" disabled={busy} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} /></label><p className="my-2 text-sm text-default-500">До 12 файлов, 10 МБ каждый, 30 МБ на пакет; до 10 000 строк и 100 колонок. Файлы с паролем, DOC/XLS, изображения и OCR не поддерживаются.</p><ul className="my-3 flex flex-col gap-2">{files.map((f, i) => <li key={`${f.name}:${i}`} className="flex justify-between gap-3 text-sm">{f.name} ({(f.size / 1024).toFixed(0)} КБ)<button type="button" onClick={() => setFiles(files.filter((_, n) => n !== i))} disabled={busy}>Исключить</button></li>)}</ul><button type="button" className={button} disabled={busy || !files.length} onClick={upload}>Разобрать файлы</button></section>}
      {job && step === 'mapping' && <><fieldset disabled={busy}><TableMapping tables={job.tables} selections={selections} onChange={setSelections} /></fieldset><div className="flex flex-wrap gap-3"><button type="button" className={button} disabled={busy || !selections.some((s) => s.included)} onClick={() => plan({ tables: selections })}>Показать план изменений</button><button type="button" disabled={busy} onClick={cancel}>Отменить импорт</button></div></>}
      {job?.plan && step === 'preview' && <>
        <div className="flex flex-wrap gap-4 text-sm">{Object.entries(job.plan.summary).map(([key, count]) => <span key={key}>{STATUS_LABELS[key as keyof typeof STATUS_LABELS]}: {count}</span>)}</div>
        <p className="text-sm text-default-600">Проверьте предложения и выберите значения конфликтов. Ошибочные строки можно исключить. После изменения решений нажмите «Пересчитать» и проверьте итог.</p>
        <fieldset disabled={busy}><ImportPreview job={job} decisions={decisions} onManualCandidate={manualCandidate} onDecision={(decision) => { setDecisions([...decisions.filter((d) => d.groupId !== decision.groupId), decision]); setDirty(true); setConfirmed(false); }} onRow={(edit) => plan({ rowEdits: [...job.rowEdits.filter((e) => e.rowId !== edit.rowId), edit] })} /></fieldset>
        <div className="flex flex-wrap gap-3"><button type="button" className={button} disabled={busy} onClick={() => plan({ decisions })}>Пересчитать решения</button><button type="button" disabled={busy} onClick={() => { setStep('mapping'); setConfirmed(false); }}>Изменить колонки</button><button type="button" disabled={busy} onClick={cancel}>Отменить импорт</button></div>
        <section className="rounded-lg border border-default-200 p-4"><p className="mb-3 text-sm">К сохранению: {job.plan.ready} карточек. Неразрешённых групп: {job.plan.blocked}. Версия плана: {job.plan.version}.</p>{dirty && <p className="mb-3 text-sm text-warning">Решения изменены. Сначала пересчитайте план.</p>}<label className="block text-sm"><input type="checkbox" checked={confirmed} disabled={busy || dirty || job.plan.blocked > 0 || job.plan.ready === 0} onChange={(e) => setConfirmed(e.target.checked)} /> Я проверил(а) итоговый план и подтверждаю выбранные изменения</label><button type="button" className={`${button} mt-3`} disabled={busy || dirty || !confirmed || job.plan.blocked > 0 || job.plan.ready === 0} onClick={confirmPlan}>Подтвердить импорт</button></section>
      </>}
      {pending && <section className="rounded-lg border p-4 text-sm"><p>Получить сохранённый результат уже отправленного подтверждения.</p><button type="button" className={`${button} mt-3`} disabled={busy} onClick={() => work(async () => done(await request<ApplyResult>(`/api/batch-import/jobs/${pending.id}/receipt?version=${pending.version}`)))}>Получить результат предыдущего подтверждения</button><button type="button" className="ml-4" disabled={busy} onClick={() => { sessionStorage.removeItem(CONFIRMATION_KEY); setPending(null); }}>Забыть подтверждение</button></section>}
    </>}
  </div>;
}
