export const ENTITIES = ['Person', 'Event', 'Excursion', 'Participation', 'PassportScan'] as const;
export type Entity = (typeof ENTITIES)[number];
export type Scalar = string | number | boolean | null;
export type Snapshot = Record<string, Scalar> & { id: string };
export type Snapshots = Record<Entity, Snapshot[]>;
export interface Operation {
  id: string;
  entity: Entity;
  entityId: string;
  before: Snapshot | null;
  after: Snapshot | null;
  parents: string[];
  deviceId: string;
  sequence: number;
  createdAt: string;
}
export interface Alias { source: string; target: string }
export interface SyncData { snapshots: Snapshots; operations: Operation[]; aliases: Alias[] }
export interface Attachment { sha256: string; path: string; bytes: number }
export interface BundleManifest {
  format: 'dolgoletie-sync';
  version: 1;
  schemaVersion: 1;
  bundleId: string;
  databaseId: string;
  deviceId: string;
  createdAt: string;
  data: { path: 'data.json'; bytes: number; sha256: string };
  attachments: Attachment[];
}
export interface Bundle { manifest: BundleManifest; data: SyncData; files: Map<string, Buffer>; digest: string }
export interface FieldOption { value: Scalar; operations: string[] }
export interface FieldConflict { field: string; local: Scalar; options: FieldOption[] }
export interface RecordPlan {
  key: string;
  entity: Entity;
  entityId: string;
  label: string;
  before: Snapshot | null;
  proposed: Snapshot | null;
  values: Snapshot;
  heads: string[];
  incoming: string[];
  conflicts: FieldConflict[];
  deletion: boolean;
  kind: 'create' | 'update' | 'delete' | 'unchanged';
  mergedIds: string[];
  constraint?: string;
}
export interface PersonCandidate { incomingId: string; localId: string; name: string }
export interface MergePlan { records: RecordPlan[]; candidates: PersonCandidate[]; aliases: Alias[] }
export interface RecordDecision {
  action: 'accept' | 'keep-local' | 'defer';
  fields?: Record<string, Scalar>;
}
export type Decisions = Record<string, RecordDecision>;
export interface ApplyResult {
  bundleId: string;
  applied: number;
  deferred: number;
  complete: boolean;
  replayed?: boolean;
  access?: { status: 'unchanged' | 'applied' | 'deferred' | 'pending'; requiresLogin?: boolean; requiresAdmin?: boolean; adminToken?: string };
}
export function emptySnapshots(): Snapshots {
  return { Person: [], Event: [], Excursion: [], Participation: [], PassportScan: [] };
}
