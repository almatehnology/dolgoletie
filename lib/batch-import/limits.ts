export const LIMITS = {
  files: 12,
  fileBytes: 10 * 1024 * 1024,
  uploadBytes: 30 * 1024 * 1024,
  expandedBytes: 40 * 1024 * 1024,
  xmlBytes: 12 * 1024 * 1024,
  entries: 1500,
  rows: 10000,
  columns: 100,
  tables: 60,
  cellChars: 10000,
  parseMs: 20000,
  jobs: 8,
  jobBytes: 24 * 1024 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  ttlMs: 30 * 60 * 1000,
  people: 100000,
} as const;

export class ImportError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export function checkDeadline(start: number) {
  if (Date.now() - start > LIMITS.parseMs) throw new ImportError('PARSE_TIMEOUT', 'Разбор занял слишком долго. Разделите файл на меньшие таблицы.', 413);
}
