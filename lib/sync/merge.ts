import { ENTITIES, type Alias, type FieldOption, type MergePlan, type Operation, type RecordPlan, type Scalar, type Snapshot, type SyncData } from './types';
import { stable, SyncError, validateSnapshot } from './validation';

const metadata = new Set(['id', 'createdAt', 'updatedAt', 'thumbPath']);
type Registers = Map<string, FieldOption[]>;

export function aliasResolver(aliases: Alias[]) {
  const map = new Map<string, string>();
  for (const { source, target } of aliases) {
    if (source === target || (map.has(source) && map.get(source) !== target)) throw new SyncError('Противоречивое объединение карточек');
    map.set(source, target);
  }
  const resolve = (id: string) => {
    const seen = new Set<string>();
    while (map.has(id)) {
      if (seen.has(id)) throw new SyncError('Циклическое объединение карточек');
      seen.add(id); id = map.get(id)!;
    }
    return id;
  };
  for (const id of map.keys()) resolve(id);
  return resolve;
}
export function recordKey(entity: string, id: string) { return `${entity}:${id}`; }
export function label(entity: string, snapshot: Snapshot | null, id: string) {
  if (!snapshot) return `${entity}: ${id}`;
  return entity === 'Person' ? [snapshot.lastName, snapshot.firstName, snapshot.middleName].filter(Boolean).join(' ') : String(snapshot.title ?? snapshot.name ?? snapshot.filename ?? id);
}

/** An immutable DAG of scalar writes. A resolution can assign an unchanged field:
 * if its parents disagree with its after image, the after image resolves them.
 * This makes recordChange(before === after, parents = all heads) meaningful. */
export function evaluateGraph(operations: Operation[], aliases: Alias[] = []) {
  const resolve = aliasResolver(aliases);
  const keyOf = (op: Operation) => recordKey(op.entity, op.entity === 'Person' ? resolve(op.entityId) : op.entityId);
  const byId = new Map<string, Operation>();
  for (const op of operations) {
    const previous = byId.get(op.id);
    if (previous && stable(previous) !== stable(op)) throw new SyncError('Операция с тем же ID имеет другое содержимое');
    byId.set(op.id, op);
  }
  const children = new Map<string, string[]>(), remaining = new Map<string, number>();
  let links = 0;
  for (const op of byId.values()) {
    if (new Set(op.parents).size !== op.parents.length) throw new SyncError('Повторяющиеся родители операции');
    remaining.set(op.id, op.parents.length);
    for (const parent of op.parents) {
      if (++links > 1000000) throw new SyncError('Слишком сложная история изменений');
      if (!byId.has(parent) || keyOf(byId.get(parent)!) !== keyOf(op)) throw new SyncError('Отсутствует родитель операции или нарушена принадлежность записи');
      const c = children.get(parent) ?? []; c.push(op.id); children.set(parent, c);
    }
  }
  const queue = [...byId.values()].filter(o => !o.parents.length).map(o => o.id).sort();
  const ordered: Operation[] = [], rank = new Map<string, number>();
  for (let i = 0; i < queue.length; i++) {
    const op = byId.get(queue[i])!;
    rank.set(op.id, ordered.length); ordered.push(op);
    for (const c of children.get(op.id) ?? []) {
      const n = remaining.get(c)! - 1; remaining.set(c, n); if (!n) queue.push(c);
    }
  }
  if (ordered.length !== byId.size) throw new SyncError('Цикл в истории изменений');
  let work = 0;
  const ancestorCache = new Map<string, boolean>();
  function ancestor(a: string, b: string) {
    if (a === b) return true;
    if (rank.get(a)! >= rank.get(b)!) return false;
    const key = `${a}\0${b}`, cached = ancestorCache.get(key);
    if (cached !== undefined) return cached;
    const todo = [b], seen = new Set<string>(); let found = false;
    while (todo.length) {
      if (++work > 5000000) throw new SyncError('Слишком сложная история изменений');
      const id = todo.pop()!;
      if (id === a) { found = true; break; }
      if (seen.has(id) || rank.get(id)! <= rank.get(a)!) continue;
      seen.add(id); todo.push(...byId.get(id)!.parents);
    }
    if (ancestorCache.size < 100000) ancestorCache.set(key, found);
    return found;
  }
  function combine(registers: Registers[]) {
    const result: Registers = new Map();
    for (const state of registers) for (const [field, options] of state) {
      const writes = new Map<string, Scalar>();
      for (const option of [...(result.get(field) ?? []), ...options]) for (const op of option.operations) writes.set(op, option.value);
      const ids = [...writes.keys()];
      const live = ids.filter(a => !ids.some(b => a !== b && ancestor(a, b)));
      const values = new Map<string, FieldOption>();
      for (const id of live.sort()) {
        const value = writes.get(id)!, k = stable(value), option = values.get(k) ?? { value, operations: [] };
        option.operations.push(id); values.set(k, option);
      }
      result.set(field, [...values.values()].sort((a,b) => stable(a.value).localeCompare(stable(b.value))));
    }
    return result;
  }
  const states = new Map<string, Registers>(), groups = new Map<string, Operation[]>();
  for (const op of ordered) {
    const state = combine(op.parents.map(id => states.get(id)!));
    const exists = op.after !== null;
    const fields = new Set(['$exists', ...Object.keys(op.after ?? {})]);
    for (const field of fields) {
      if (metadata.has(field)) continue;
      if (field !== '$exists' && !exists) continue;
      const canonical = (v: Scalar) => field === 'personId' && typeof v === 'string' ? resolve(v) : v;
      const before = field === '$exists' ? op.before !== null : canonical(op.before?.[field] ?? null);
      const after = field === '$exists' ? exists : canonical(op.after?.[field] ?? null);
      const inherited = state.get(field) ?? [];
      // A full after image resolves inherited disagreements, even when the
      // chosen value equals the local before image (explicit keep-local).
      // Importing a previously absent local row with causal parents adopts their
      // unchanged registers. It must not invent concurrent writes to every field.
      if (field === '$exists' || field === 'deletedAt' || (op.before !== null && stable(before) !== stable(after)) || !inherited.length || inherited.some(v => stable(v.value) !== stable(after))) {
        state.set(field, [{ value: after, operations: [op.id] }]);
      }
    }
    states.set(op.id, state);
    const key = keyOf(op), group = groups.get(key) ?? []; group.push(op); groups.set(key, group);
  }
  const records = new Map<string, { registers: Registers; heads: string[]; operations: Operation[] }>();
  for (const [key, ops] of groups) {
    const heads = ops.filter(o => !(children.get(o.id)?.length)).map(o => o.id).sort();
    records.set(key, { registers: combine(heads.map(id => states.get(id)!)), heads, operations: ops });
  }
  return { records, ordered, resolve };
}

export function buildMergePlan(local: SyncData, remote: SyncData, selectedAliases: Alias[] = []): MergePlan {
  const aliases = [...local.aliases, ...remote.aliases, ...selectedAliases];
  const graph = evaluateGraph([...local.operations, ...remote.operations], aliases);
  const localIds = new Set(local.operations.map(o => o.id));
  const records: RecordPlan[] = [];
  for (const [key, state] of graph.records) {
    const incoming = state.operations.filter(o => !localIds.has(o.id)).map(o => o.id);
    const exemplar = state.operations[0], entity = exemplar.entity;
    const entityId = entity === 'Person' ? graph.resolve(exemplar.entityId) : exemplar.entityId;
    const localBefore = local.snapshots[entity].find(s => s.id === entityId) ?? (entity === 'Person' ? local.snapshots.Person.find(s => graph.resolve(s.id) === entityId) : undefined);
    const before: Snapshot | null = localBefore ? { ...localBefore, id: entityId } : null;
    const mergedIds = entity === 'Person' ? [...new Set(state.operations.map(o => o.entityId))].filter(id => id !== entityId && local.snapshots.Person.some(p => p.id === id)) : [];
    const relationRemap = before?.personId && graph.resolve(String(before.personId)) !== before.personId;
    if (!incoming.length && !mergedIds.length && !relationRemap) continue;
    const values: Snapshot = { ...(before ?? state.operations.find(o => o.after)?.after ?? {}), id: entityId };
    let exists = true;
    const conflicts = [];
    for (const [field, options] of state.registers) {
      const localValue = field === '$exists' ? before !== null : before?.[field] ?? null;
      if (options.length > 1) conflicts.push({ field, local: localValue, options });
      const chosen = options.length === 1 ? options[0].value : localValue;
      if (field === '$exists') exists = chosen !== false;
      else values[field] = chosen;
    }
    const proposed: Snapshot | null = exists ? values : null;
    if (proposed) {
      // These timestamps are presentation metadata, never conflict winners.
      for (const field of ['createdAt','updatedAt']) {
        const values = state.operations.flatMap(o => o.after?.[field] ? [String(o.after[field])] : []).sort();
        if (values.length) proposed[field] = before?.[field] ?? values[0];
      }
      if (entity === 'PassportScan') proposed.thumbPath = null;
    }
    const remoteDeletion = [...state.registers.entries()].some(([field, options]) =>
      (field === '$exists' || field === 'deletedAt') && options.some(v => (field === '$exists' ? v.value === false : v.value !== null) && v.operations.some(id => !localIds.has(id))));
    const deletion = remoteDeletion || mergedIds.length > 0;
    const kind = !proposed ? 'delete' : !before ? 'create' : stable(before) !== stable(proposed) ? 'update' : 'unchanged';
    records.push({ key, entity, entityId, label: label(entity, proposed ?? before, entityId), before, proposed, values, heads: state.heads, incoming, conflicts, deletion, kind, mergedIds });
  }
  const name = (p: Snapshot) => [p.lastName,p.firstName,p.middleName].map(v => String(v ?? '').trim().normalize('NFKC').toLocaleLowerCase('ru')).join('|');
  const resolveExisting=aliasResolver([...local.aliases,...remote.aliases]);
  const candidates = remote.snapshots.Person.filter(p => !p.deletedAt && !local.snapshots.Person.some(l => l.id === p.id)).flatMap(p =>
    local.snapshots.Person.filter(l => !l.deletedAt && l.id !== p.id && name(l) === name(p) && resolveExisting(l.id) !== resolveExisting(p.id)).map(l => ({ incomingId: p.id, localId: l.id, name: label('Person', p, p.id) })));
  const pairs = new Map<string, string[]>();
  const participation = new Map(local.snapshots.Participation.map(p => [p.id, p]));
  for (const r of records.filter(r => r.entity === 'Participation')) {
    if (r.proposed) participation.set(r.entityId,r.proposed); else participation.delete(r.entityId);
  }
  for (const p of participation.values()) {
    const pair = `${graph.resolve(String(p.personId))}\0${p.eventId}`, ids = pairs.get(pair) ?? []; ids.push(p.id); pairs.set(pair,ids);
  }
  for (const ids of pairs.values()) if(ids.length>1) for(const r of records) if(r.entity==='Participation' && ids.includes(r.entityId)) r.constraint='Несколько участий одного человека в одном мероприятии. Оставьте одно участие; остальные отклоните или отложите.';
  for (const r of records) if (r.proposed) {
    try {validateSnapshot(r.entity,r.proposed);} catch (error) {r.constraint=error instanceof SyncError ? error.message : 'Итоговая запись требует исправления';}
  }
  return { records: records.sort((a,b) => a.key.localeCompare(b.key)), candidates, aliases };
}

export function assertSnapshotHistory(data: SyncData) {
  const graph = evaluateGraph(data.operations, data.aliases);
  for (const entity of ENTITIES) {
    const ids = new Set<string>();
    for (const snapshot of data.snapshots[entity]) {
      if (ids.has(snapshot.id)) throw new SyncError('Повторяющийся ID в снимке'); ids.add(snapshot.id);
      const state = graph.records.get(recordKey(entity, snapshot.id));
      if (!state || state.registers.get('$exists')?.[0]?.value !== true) throw new SyncError('Снимок не соответствует истории изменений');
      for (const [field, options] of state.registers) {
        if (options.length !== 1 || (field !== '$exists' && stable(options[0].value) !== stable(snapshot[field] ?? null))) throw new SyncError('Снимок содержит неразрешённую или противоречивую историю');
      }
    }
    for (const [key,state] of graph.records) {
      if (key.startsWith(`${entity}:`) && state.registers.get('$exists')?.some(o => o.value === true) && !ids.has(key.slice(entity.length+1))) throw new SyncError('В снимке отсутствует запись из истории');
    }
  }
}
