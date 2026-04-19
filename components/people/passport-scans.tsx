'use client';

import { Button, Modal } from '@heroui/react';
import { useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/lib/store/hooks';
import { toggleScansRevealed } from '@/lib/store/ui-slice';
import { useDeleteScanMutation, useUploadScansMutation } from '@/lib/store/scans-api';
import { FullScreenModal } from '@/components/full-screen-modal';
import { formatDate } from '@/lib/format';
import type { PassportScan } from '@/lib/store/people-api';

interface Props {
  personId: string;
  scans: PassportScan[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}

export function PassportScansBlock({ personId, scans }: Props) {
  const dispatch = useAppDispatch();
  const revealed = useAppSelector((s) => s.ui.scansRevealedFor[personId] ?? true);
  const [uploadScans, { isLoading: uploading }] = useUploadScansMutation();
  const [deleteScan] = useDeleteScanMutation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);

  const viewing = viewId ? scans.find((s) => s.id === viewId) ?? null : null;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      await uploadScans({ personId, files: Array.from(files) }).unwrap();
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      const e = err as { data?: { error?: { message?: string } } };
      setError(e.data?.error?.message ?? 'Не удалось загрузить');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={revealed ? 'secondary' : 'primary'}
          onPress={() => dispatch(toggleScansRevealed(personId))}
        >
          {revealed ? 'Скрыть сканы' : `Показать сканы (${scans.length})`}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.currentTarget.files)}
        />
        <Button variant="outline" isDisabled={uploading} onPress={() => inputRef.current?.click()}>
          {uploading ? 'Загрузка…' : 'Загрузить файлы'}
        </Button>
        <span className="text-xs text-default-500">JPG, PNG, WebP, PDF · до 10 МБ/файл</span>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {revealed ? (
        scans.length === 0 ? (
          <p className="text-sm text-default-500">Файлы ещё не загружены.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {scans.map((scan) => (
              <ScanCard
                key={scan.id}
                scan={scan}
                onView={() => setViewId(scan.id)}
                onDelete={async () => {
                  if (!confirm(`Удалить "${scan.filename}"?`)) return;
                  await deleteScan({ id: scan.id, personId });
                }}
              />
            ))}
          </div>
        )
      ) : null}

      <FullScreenModal isOpen={!!viewing} onOpenChange={(v) => !v && setViewId(null)}>
        <Modal.Header className="flex items-center justify-between border-b border-default-200 px-5 py-3">
          <Modal.Heading className="truncate text-base font-semibold">
            {viewing?.filename ?? ''}
          </Modal.Heading>
          <Modal.CloseTrigger />
        </Modal.Header>
        <Modal.Body className="flex-1 overflow-auto bg-default-50 p-0">
          {viewing ? (
            viewing.mimeType === 'application/pdf' ? (
              <object
                data={`/api/scans/${viewing.id}`}
                type="application/pdf"
                className="h-full w-full"
              >
                <a href={`/api/scans/${viewing.id}`} className="text-primary hover:underline">
                  Открыть PDF
                </a>
              </object>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/scans/${viewing.id}`}
                alt={viewing.filename}
                className="mx-auto max-h-full max-w-full object-contain"
              />
            )
          ) : null}
        </Modal.Body>
        <Modal.Footer className="border-t border-default-200 px-5 py-3">
          <a
            href={`/api/scans/${viewing?.id ?? ''}`}
            download={viewing?.filename}
            className="text-sm text-primary hover:underline"
          >
            Скачать
          </a>
        </Modal.Footer>
      </FullScreenModal>
    </div>
  );
}

function ScanCard({
  scan,
  onView,
  onDelete,
}: {
  scan: PassportScan;
  onView: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-default-200 bg-surface p-2">
      <button
        type="button"
        onClick={onView}
        className="aspect-[3/4] w-full overflow-hidden rounded border border-default-200 bg-default-50"
      >
        {scan.mimeType === 'application/pdf' ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-default-500">
            <span className="text-2xl">📄</span>
            <span className="text-xs">PDF</span>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/scans/${scan.id}/thumb`}
            alt={scan.filename}
            className="h-full w-full object-cover"
          />
        )}
      </button>
      <div className="min-w-0">
        <div className="truncate text-xs text-default-700" title={scan.filename}>
          {scan.filename}
        </div>
        <div className="text-[10px] text-default-500">
          {formatSize(scan.sizeBytes)} · {formatDate(scan.uploadedAt)}
        </div>
      </div>
      <Button size="sm" variant="ghost" onPress={onDelete}>
        Удалить
      </Button>
    </div>
  );
}
