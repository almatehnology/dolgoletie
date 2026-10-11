import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readAuth } from '@/lib/auth/store';
import { verifyPassword } from '@/lib/auth/password';
import { accessFingerprint, type TransferAccess } from '@/lib/crypto/bundle';
import { unwrapPassword } from '@/lib/crypto/primitives';
import { registerSyncAccessIntegration, type AccessDecision, type AccessResult } from '@/lib/sync/access';
import { readVault, writeVault, vaultKey, convertVault, vaultUnlock, type VaultConfig } from './vault';
import { commitCredentialFiles } from './credential-transaction';
import { dataDirectory } from './paths';
import { withAuthOperation } from '@/lib/auth/mutex';
import { authMetadataSchema, primaryAccountSchema } from '@/lib/auth/metadata-schema';
import { vaultConfigSchema } from './vault-schema';
import { atomicJson, readProtectedJson, removeDurably } from './atomic-files';

type Node = NonNullable<VaultConfig['accessHistory']>[number];
const identifier = (vault: VaultConfig, fingerprint: string) => vault.accessRevision === 'initial' ? fingerprint : vault.accessRevision;
function nodes(vault: VaultConfig, fingerprint: string): Node[] { return vault.accessHistory ?? [{ id: identifier(vault, fingerprint), parents: [], fingerprint }]; }
function combined(local: Node[], incoming: Node[]) {
  if (local.length + incoming.length > 2000) throw new Error('Слишком большая история доступа');
  const graph = new Map<string, Node>();
  for (const node of [...local, ...incoming]) {
    if (typeof node.id !== 'string' || !Array.isArray(node.parents) || node.parents.length > 2000 || typeof node.fingerprint !== 'string') throw new Error('Повреждена история доступа');
    const old = graph.get(node.id);
    if (old && JSON.stringify(old) !== JSON.stringify(node)) throw new Error('Несогласованная история доступа');
    graph.set(node.id, node);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Циклическая история доступа');
    if (visited.has(id)) return;
    const node = graph.get(id); if (!node) throw new Error('Неполная история доступа');
    visiting.add(id); node.parents.forEach(visit); visiting.delete(id); visited.add(id);
  };
  graph.forEach((_node, id) => visit(id));
  return graph;
}
function ancestor(graph: Map<string, Node>, parent: string, child: string): boolean {
  const seen = new Set<string>(), pending = [child];
  while (pending.length) { const id = pending.pop()!; if (id === parent) return true; if (!seen.has(id)) { seen.add(id); pending.push(...(graph.get(id)?.parents ?? [])); } }
  return false;
}
function transfer(input: unknown): TransferAccess | null {
  if (input == null) return null;
  const v = input as TransferAccess;
  return { ...v, vault: vaultConfigSchema.parse(v.vault), primary: v.primary ? primaryAccountSchema.parse(v.primary) : undefined };
}
async function compare(input: unknown) {
  const incoming = transfer(input), auth = await readAuth(), local = readVault();
  if (!incoming?.primary) return { incoming, auth, local, needed: false, graph: new Map<string, Node>(), localId: '', incomingId: '' };
  const current = accessFingerprint({ primary: auth.primary, vault: local }), remote = accessFingerprint(incoming);
  const localId = identifier(local, current), incomingId = identifier(incoming.vault, remote);
  const graph = combined(nodes(local, current), nodes(incoming.vault, remote));
  if (graph.get(localId)?.fingerprint !== current || graph.get(incomingId)?.fingerprint !== remote) throw new Error('История не соответствует текущему доступу');
  return { incoming, auth, local, localId, incomingId, graph, needed: current !== remote && !ancestor(graph, incomingId, localId) };
}
async function commitAccess(input: unknown, decision?: AccessDecision, adminProof?: { proof: string; recovery: boolean; incomingPassword?: string }): Promise<AccessResult & { requiresAdmin?: boolean; adminToken?: string }> {
  const c = await compare(input);
  if (!c.needed) return { status: 'unchanged' };
  if (!decision || decision.choice === 'defer') return { status: 'deferred' };
  const incoming = c.incoming!;
  const next: VaultConfig = { ...c.local, accessRevision: randomUUID() };
  if (decision.choice === 'local') {
    next.accessHistory = [...c.graph.values(), { id: next.accessRevision, parents: [c.localId, c.incomingId], fingerprint: accessFingerprint({ primary: c.auth.primary, vault: next }) }];
    writeVault(next); return { status: 'applied' };
  }
  if (c.local.enabled !== incoming.vault.enabled && !adminProof) {
    const token = randomUUID(), folder = join(dataDirectory(), 'pending-access'); mkdirSync(folder, { recursive: true });
    // Protected descriptor survives logout/restart. It contains no records or live secrets.
    const descriptor = { format: 1, incoming: { primary: incoming.primary, vault: incoming.vault }, fingerprint: accessFingerprint({ primary: c.auth.primary, vault: c.local }), createdAt: Date.now() };
    atomicJson(join(folder, `${token}.json`), descriptor);
    return { status: 'pending', requiresAdmin: true, adminToken: token };
  }
  if (adminProof && (!c.auth.primary || (!adminProof.recovery && !await verifyPassword(c.auth.primary.passwordHash, adminProof.proof)))) throw new Error('Неверный текущий пароль пользователя');
  if (adminProof?.recovery && !c.local.enabled) throw new Error('Код восстановления доступен только для зашифрованной локальной базы');
  let root: Buffer | undefined;
  try {
    c.auth.primary = { ...incoming.primary!, version: Math.max(c.auth.primary?.version ?? 0, incoming.primary!.version) + 1 };
    authMetadataSchema.parse(c.auth);
    let committed = false;
    const commit = (config: VaultConfig) => {
      const result = { ...config, accessRevision: next.accessRevision };
      result.accessHistory = [...c.graph.values(), { id: result.accessRevision, parents: [c.localId, c.incomingId], fingerprint: accessFingerprint({ primary: c.auth.primary, vault: result }) }];
      commitCredentialFiles(c.auth, result); Object.assign(next, result); committed = true;
    };
    if (incoming.vault.enabled) {
      const password = adminProof?.incomingPassword ?? incoming.password;
      if (!password) throw new Error('Введите пароль входящего файла');
      if (!await verifyPassword(incoming.primary!.passwordHash, password)) throw new Error('Пароль входящего пользователя не подходит');
      root = await unwrapPassword(incoming.vault.passwordSlot!, password);
      const sameKey = c.local.enabled && !adminProof && vaultKey().equals(root);
      if (!sameKey) {
        const proof = adminProof?.proof ?? decision.localPassword;
        if (!proof && c.local.enabled) throw new Error('Введите текущий пароль локальной базы');
        await convertVault(true, proof ?? '', adminProof?.recovery ?? false, { root, passwordSlot: incoming.vault.passwordSlot!, recoverySlot: incoming.vault.recoverySlot!, accessRevision: next.accessRevision }, commit);
      }
      Object.assign(next, readVault(), { accessRevision: next.accessRevision, passwordSlot: incoming.vault.passwordSlot, recoverySlot: incoming.vault.recoverySlot });
    } else if (c.local.enabled) {
      if (!adminProof) throw new Error('Смена режима требует admin');
      await convertVault(false, adminProof.proof, adminProof.recovery, undefined, commit);
      Object.assign(next, readVault(), { accessRevision: next.accessRevision });
      delete next.passwordSlot; delete next.recoverySlot;
    }
    if (!committed) commit(next);
    // Keep the authorized internal connection available until the sync receipt is
    // durably updated; all previous primary cookies are already invalidated.
    if (next.enabled) await vaultUnlock(adminProof?.incomingPassword ?? incoming.password!);
    return { status: 'applied', requiresLogin: true };
  } finally { root?.fill(0); }
}

registerSyncAccessIntegration({
  async preview(input) {
    const c = await compare(input); if (!c.needed) return null;
    return { required: true, requiresProof: c.local.enabled && c.incoming!.vault.enabled, message: c.local.enabled !== c.incoming!.vault.enabled ? 'Файл содержит другой режим шифрования. После подтверждения данных смену режима завершает admin с подтверждением доступа пользователя.' : 'Изменены пароль или ключ восстановления. Выберите итоговый доступ; более старые версии не применяются автоматически.' };
  },
  async apply(input, decision) {
    const c = await compare(input); if (!c.needed) return { status: 'unchanged' };
    const d = decision as AccessDecision | undefined;
    if (!d) throw new Error('Выберите решение по доступу');
    if (d.choice === 'defer') return { status: 'deferred' };
    if (d.choice === 'incoming' && c.local.enabled && c.incoming!.vault.enabled && (!Buffer.isBuffer(c.incoming!.root) || c.incoming!.root!.length !== 32)) throw new Error('Пароль файла требуется заново. Повторите загрузку');
    if (d.choice === 'incoming' && c.local.enabled && c.incoming!.vault.enabled && !vaultKey().equals(c.incoming!.root!)) {
      if (!d.localPassword || !c.auth.primary || !await verifyPassword(c.auth.primary.passwordHash, d.localPassword)) throw new Error('Введите текущий пароль локальной базы');
    }
    return { status: 'applied' };
  },
  async postCommit(input, decision) { return withAuthOperation(() => commitAccess(input, decision as AccessDecision | undefined)); },
});

export async function completePendingAccess(token: string, proof: string, recovery: boolean, incomingPassword?: string) {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Недопустимый идентификатор операции');
  const path = join(dataDirectory(), 'pending-access', `${token}.json`);
  if (!existsSync(path)) throw new Error('Операция не найдена. Повторите загрузку файла');
  const data = readProtectedJson(path) as { format: number; createdAt: number; fingerprint: string; incoming: unknown };
  if (data.format !== 1 || Date.now() - data.createdAt > 7 * 24 * 60 * 60 * 1000) throw new Error('Срок операции истёк. Повторите загрузку файла');
  const auth = await readAuth(), vault = readVault();
  if (data.fingerprint !== accessFingerprint({ primary: auth.primary, vault })) throw new Error('Локальный доступ изменился. Повторите синхронизацию');
  const result = await commitAccess(data.incoming, { choice: 'incoming' }, { proof, recovery, incomingPassword });
  if (result.status !== 'pending') removeDurably(path);
  return result;
}
