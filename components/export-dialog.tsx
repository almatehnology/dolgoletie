'use client';

import { Button, Modal } from '@heroui/react';
import { useId, useRef, useState } from 'react';
import { FullScreenModal } from '@/components/full-screen-modal';
import { PERSON_FIELDS, type PersonFieldKey } from '@/lib/person-fields';
import { saveLocalFile } from '@/lib/desktop-files';
import { safeDownloadName } from '@/lib/file-names';
import type { ReportContext, ReportFormat, ReportOrientation, ReportRequest } from '@/lib/report-export/model';
import {
  loadExportPreferences,
  saveExportPreferences,
} from '@/lib/report-export/preferences';

type ReportTarget =
  | { context: Extract<ReportContext, 'people'>; personIds: readonly string[] }
  | { context: Exclude<ReportContext, 'people'>; eventId: string; participantCount?: number; eventTitle?: string };

export type ExportDialogProps = ReportTarget & {
  isOpen: boolean;
  onClose: () => void;
  preferenceScope?: string;
};

const SESSION_ERROR = 'Сессия недоступна. Войдите в систему и повторите экспорт.';

export function getDownloadFilename(contentDisposition: string | null, format: ReportFormat): string {
  let filename = '';
  const encoded = contentDisposition?.match(/filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  if (encoded) {
    const value = (encoded[1] ?? encoded[2]).trim();
    const utf8 = value.match(/^UTF-8'[^']*'(.*)$/i);
    if (utf8) {
      try { filename = decodeURIComponent(utf8[1]); } catch { /* Try the plain filename instead. */ }
    }
  }
  if (!filename) {
    const plain = contentDisposition?.match(/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
    filename = (plain?.[1] ?? plain?.[2] ?? '').trim();
  }
  return safeDownloadName(filename.split(/[\\/]/).pop() ?? '', format);
}

async function responseError(response: Response): Promise<string> {
  if (response.redirected || response.headers.get('content-type')?.toLowerCase().includes('text/html')) return SESSION_ERROR;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') {
      const data = body as { error?: unknown; message?: unknown };
      const message = typeof data.error === 'string' ? data.error :
        data.error && typeof data.error === 'object' ? (data.error as { message?: unknown }).message : data.message;
      if (typeof message === 'string' && message.trim()) return message;
    }
  } catch { /* Non-JSON errors use the same readable fallback. */ }
  if (response.status === 401 || response.status === 403 || response.status === 423) return SESSION_ERROR;
  return 'Не удалось сформировать отчёт. Повторите попытку.';
}

export function ExportDialog(props: ExportDialogProps) {
  if (!props.isOpen) return null;
  return <OpenExportDialog key={`${props.context}:${props.preferenceScope ?? 'local'}`} {...props} />;
}

function OpenExportDialog(props: ExportDialogProps) {
  const [initial] = useState(() => loadExportPreferences(props.context, props.preferenceScope));
  const [fields, setFields] = useState<PersonFieldKey[]>(initial.fields);
  const [format, setFormat] = useState<ReportFormat>(initial.format);
  const [orientation, setOrientation] = useState<ReportOrientation>(initial.orientation);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const validationId = useId();
  const errorId = useId();
  const personIds = props.context === 'people' ? [...new Set(props.personIds)] : [];
  const selectionError = props.context === 'people' && personIds.length === 0
    ? 'Не выбраны люди. Закройте окно и отметьте людей в списке.'
    : props.context !== 'people' && !props.eventId
      ? 'Мероприятие недоступно. Откройте его карточку заново.'
      : fields.length === 0 ? 'Выберите хотя бы одно поле карточки.' : null;
  const title = props.context === 'people' ? 'Экспорт выбранных людей' :
    props.context === 'event-details' ? 'Экспорт сведений мероприятия' : 'Экспорт участников';

  function toggleField(key: PersonFieldKey) {
    setFields((current) => current.includes(key) ? current.filter((field) => field !== key) : [...current, key]);
    setError(null);
  }

  function moveField(index: number, direction: -1 | 1) {
    setFields((current) => {
      const next = [...current];
      const destination = index + direction;
      if (destination < 0 || destination >= next.length) return current;
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
    setError(null);
  }

  async function download() {
    if (busyRef.current) return;
    if (selectionError) { setError(selectionError); return; }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let downloaded = false;
    try {
      const request: ReportRequest = {
        context: props.context,
        ...(props.context === 'people' ? { personIds } : { eventId: props.eventId }),
        fields,
        format,
        orientation,
      };
      const response = await fetch('/api/reports/export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!response.ok || response.redirected || contentType?.includes('json') || contentType === 'text/html') {
        throw new Error(await responseError(response));
      }
      const expectedType = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (contentType !== expectedType && contentType !== 'application/octet-stream') {
        throw new Error('Сервер не вернул файл отчёта. Войдите в систему и повторите экспорт.');
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('Получен пустой файл отчёта. Повторите попытку.');
      if (!await saveLocalFile(blob, getDownloadFilename(response.headers.get('content-disposition'), format))) return;
      saveExportPreferences(props.context, { fields, format, orientation }, props.preferenceScope);
      downloaded = true;
    } catch (err) {
      setError(err instanceof Error && !(err instanceof TypeError)
        ? err.message : 'Не удалось скачать отчёт. Проверьте соединение и повторите попытку.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    if (downloaded) props.onClose();
  }

  return (
    <FullScreenModal isOpen onOpenChange={(open) => { if (!open && !busyRef.current) props.onClose(); }}>
      <Modal.Header className="flex items-center justify-between gap-3 border-b border-default-200 px-6 py-4">
        <Modal.Heading className="text-lg font-semibold">{title}</Modal.Heading>
        <Modal.CloseTrigger aria-label="Закрыть настройки экспорта" isDisabled={busy} />
      </Modal.Header>
      <Modal.Body className="flex flex-1 flex-col gap-5 overflow-auto p-6" aria-busy={busy}>
        <p id={descriptionId} className="text-sm text-default-600">
          {props.context === 'people' ? `В отчёт войдут выбранные люди: ${personIds.length}.` : (
            <>
              {props.eventTitle ? <span className="block font-medium">{props.eventTitle}</span> : null}
              {props.context === 'event-details' ? 'Общие сведения мероприятия и все его участники.' : 'Название, дата мероприятия и все его участники.'}
              {props.participantCount !== undefined ? ` Участников сейчас: ${props.participantCount}.` : ''}
              {props.participantCount === 0 ? ' Будет сформирован отчёт с заголовками и отметкой пустого списка.' : ''}
            </>
          )}
        </p>
        <p className="text-sm text-default-500">В таблицу входят только выбранные поля карточек людей. Фотографии и документы не включаются.</p>
        <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
          <legend className="sr-only">Формат и ориентация отчёта</legend>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Формат файла
            <select className="rounded-md border border-default-300 bg-background px-3 py-2" value={format} onChange={(event) => { setFormat(event.target.value as ReportFormat); setError(null); }}>
              <option value="pdf">PDF — для просмотра и печати</option>
              <option value="xlsx">XLSX — таблица Excel</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Ориентация страницы
            <select className="rounded-md border border-default-300 bg-background px-3 py-2" value={orientation} onChange={(event) => { setOrientation(event.target.value as ReportOrientation); setError(null); }}>
              <option value="portrait">Портретная</option>
              <option value="landscape">Альбомная</option>
            </select>
            {format === 'xlsx' ? <span className="text-xs font-normal text-default-500">Для XLSX задаёт ориентацию при печати.</span> : null}
          </label>
        </fieldset>
        <div className="grid gap-6 lg:grid-cols-2">
          <fieldset disabled={busy} className="min-w-0">
            <legend className="mb-3 font-medium">Поля карточки</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {PERSON_FIELDS.map((field) => (
                <label key={field.key} className="flex cursor-pointer items-start gap-2 rounded-md border border-default-200 p-3 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={fields.includes(field.key)} onChange={() => toggleField(field.key)} />
                  {field.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="min-w-0">
            <h2 className="mb-2 font-medium">Порядок колонок ({fields.length})</h2>
            <p className="mb-3 text-sm text-default-500">Поля выводятся слева направо в этом порядке. Меняйте порядок кнопками «Вверх» и «Вниз».</p>
            <ol className="flex flex-col gap-2" aria-label="Порядок колонок отчёта" aria-live="polite" aria-relevant="additions text">
              {fields.map((key, index) => {
                const label = PERSON_FIELDS.find((field) => field.key === key)?.label ?? key;
                return (
                  <li key={key} className="flex flex-wrap items-center gap-2 rounded-md border border-default-200 p-2 text-sm">
                    <span className="min-w-0 flex-1">{index + 1}. {label}</span>
                    <Button size="sm" variant="ghost" aria-label={`Переместить «${label}» вверх`} isDisabled={busy || index === 0} onPress={() => moveField(index, -1)}>Вверх</Button>
                    <Button size="sm" variant="ghost" aria-label={`Переместить «${label}» вниз`} isDisabled={busy || index === fields.length - 1} onPress={() => moveField(index, 1)}>Вниз</Button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
        {selectionError ? <p id={validationId} role="status" className="text-sm text-danger">{selectionError}</p> : null}
        {error ? <p id={errorId} role="alert" className="text-sm text-danger">{error}</p> : null}
        <p className="text-xs text-default-500">Параметры сохранятся в этом браузере после успешного скачивания отдельно для каждого вида отчёта.</p>
      </Modal.Body>
      <Modal.Footer className="flex flex-wrap justify-end gap-2 border-t border-default-200 px-6 py-4">
        <span role="status" className="mr-auto self-center text-sm text-default-500">{busy ? 'Формируем отчёт…' : ''}</span>
        <Button variant="ghost" isDisabled={busy} onPress={props.onClose}>Отмена</Button>
        <Button variant="primary" isDisabled={busy || !!selectionError} aria-describedby={[descriptionId, selectionError ? validationId : '', error ? errorId : ''].filter(Boolean).join(' ')} onPress={download}>
          {busy ? 'Подготовка…' : `Скачать ${format.toUpperCase()}`}
        </Button>
      </Modal.Footer>
    </FullScreenModal>
  );
}
