import type { Prisma } from '@prisma/client';
import { SyncError } from './validation';

export interface AccessPreview { required: boolean; message: string; requiresProof?: boolean; details?: unknown }
export interface AccessDecision { choice: 'incoming' | 'local' | 'defer'; localPassword?: string }
export interface AccessResult { status: 'unchanged' | 'applied' | 'deferred' | 'pending'; requiresLogin?: boolean; requiresAdmin?: boolean; adminToken?: string }
export interface SyncAccessIntegration {
  preview(access: unknown, tx: Prisma.TransactionClient): Promise<AccessPreview | null>;
  apply(access: unknown, decision: unknown, tx: Prisma.TransactionClient): Promise<AccessResult>;
  postCommit?(access: unknown, decision: unknown, result: AccessResult): Promise<AccessResult>;
}
let integration: SyncAccessIntegration | undefined;
let loading:Promise<unknown>|undefined;
async function ensureIntegration() {
  if(!integration) {loading ??= import('@/lib/storage/sync-access');await loading;}
}
/** Register the credential transport here from the vault/auth integration.
 * Do not mutate access during preview. Apply must be transactional or return
 * a recoverable pending state; a failed transfer must throw, never report done. */
export function registerSyncAccessIntegration(value: SyncAccessIntegration) { integration = value; }
export async function previewSyncAccess(access: unknown, tx: Prisma.TransactionClient): Promise<AccessPreview | null> {
  await ensureIntegration();
  if (integration) return integration.preview(access,tx);
  return access == null ? null : { required: true, message: 'Пакет содержит параметры доступа. Требуется подключение переноса доступа.' };
}
export async function applySyncAccess(access: unknown, decision: unknown, tx: Prisma.TransactionClient) {
  await ensureIntegration();
  if (integration) return integration.apply(access,decision,tx);
  if (access != null) throw new SyncError('Перенос доступа ещё не подключён; пакет не применён',409,'SYNC_ACCESS_PENDING');
  return undefined;
}
export function hasSyncAccessPostCommit() { return !!integration?.postCommit; }
export async function completeSyncAccess(access:unknown,decision:unknown,result:AccessResult):Promise<AccessResult> {
  await ensureIntegration();
  return integration?.postCommit ? integration.postCommit(access,decision,result) : result;
}
