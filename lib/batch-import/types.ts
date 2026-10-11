import type { PersonFieldKey } from '@/lib/person-fields';

export type Values = Partial<Record<PersonFieldKey, string>>;
export type ColumnKey = PersonFieldKey | 'fullName' | 'passportSeries' | 'passportDigits';
export type Cell = {
  text: string;
  kind?: 'text' | 'number' | 'date';
  date?: string;
  number?: number;
  error?: string;
  warning?: string;
  /** Zero based master column; used for headings only, never copied into data. */
  mergedFrom?: { row: number; column: number };
};
export type Table = {
  id: string;
  fileName: string;
  name: string;
  rows: { number: number; cells: Cell[] }[];
  date1904?: boolean;
  warnings: string[];
  selection: TableSelection;
};
export type TableSelection = {
  tableId: string;
  included: boolean;
  headerStart: number;
  headerEnd: number;
  columns: (ColumnKey | null)[];
};
export type Source = { fileName: string; table: string; row: number; column: number; raw: string };
export type ValueSource = { value: string; source: Source };
export type ImportRow = {
  id: string;
  sources: Source[];
  values: Partial<Record<PersonFieldKey, ValueSource[]>>;
  errors: string[];
  warnings: string[];
  excluded: boolean;
};
export type RowEdit = { rowId: string; excluded?: boolean; values?: Values; acknowledgeWarnings?: boolean; separate?: boolean; mergeWith?: string | null };
export type PersonSnapshot = {
  id: string;
  values: Values;
  updatedAt: string;
  deletedAt: string | null;
};
export type Candidate = PersonSnapshot & { reasons: string[]; compatible: boolean };
export type Decision = {
  groupId: string;
  action: 'auto' | 'new' | 'existing' | 'skip';
  personId?: string;
  restore?: boolean;
  /** A choice is a final nonempty value, or null to keep an existing value / omit a new field. */
  fields?: Partial<Record<PersonFieldKey, string | null>>;
};
export type FieldChange = {
  key: PersonFieldKey;
  current: string | null;
  incoming: ValueSource[];
  value: string | null;
  kind: 'addition' | 'same' | 'conflict' | 'replacement' | 'kept';
  resolved: boolean;
};
export type PlanGroup = {
  id: string;
  rowIds: string[];
  sources: Source[];
  values: Values;
  candidates: Candidate[];
  target: PersonSnapshot | null;
  action: 'new' | 'existing' | 'skip' | 'unresolved';
  status: 'new' | 'addition' | 'same' | 'conflict' | 'error' | 'skipped';
  changes: FieldChange[];
  errors: string[];
  warnings: string[];
  ready: boolean;
  restore: boolean;
  /** Snapshot of all matching candidates, including archived records. */
  candidateSignature: string;
};
export type Plan = {
  version: number;
  groups: PlanGroup[];
  summary: Record<PlanGroup['status'], number>;
  ready: number;
  blocked: number;
};
export type ApplyResult = {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  restored: number;
  people: { id: string; action: 'created' | 'updated' | 'unchanged'; groupId: string }[];
};
export type Job = {
  id: string;
  owner: string;
  createdAt: number;
  expiresAt: number;
  revision: number;
  tables: Table[];
  rowEdits: RowEdit[];
  decisions: Decision[];
  manualCandidateIds: string[];
  plan: Plan | null;
  result: ApplyResult | null;
  busy: boolean;
  bytes: number;
};
export type JobView = Omit<Job, 'owner' | 'busy' | 'bytes' | 'manualCandidateIds'>;
