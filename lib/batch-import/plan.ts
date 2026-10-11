import { createHash } from 'node:crypto';
import { PERSON_FIELDS } from '@/lib/person-fields';
import { compareKey, hasInitials, normalizeValue } from './normalize';
import { CandidateIndex, candidateSignature, fullIdentity, groupRows, nameIdentity, rowValues } from './match';
import { extractRows } from './rows';
import type { Decision, FieldChange, Job, PersonSnapshot, Plan, PlanGroup, Values, ValueSource } from './types';

export function buildPlan(job: Pick<Job, 'tables' | 'rowEdits' | 'decisions' | 'manualCandidateIds' | 'revision'>, people: PersonSnapshot[]): Plan {
  const rows = extractRows(job.tables, job.rowEdits);
  const index = new CandidateIndex(people);
  const clusters = groupRows(rows, new Set(job.rowEdits.filter((e) => e.separate).map((e) => e.rowId)), new Map(job.rowEdits.filter((e) => e.mergeWith).map((e) => [e.rowId, e.mergeWith!])));
  const decisions = new Map(job.decisions.map((d) => [d.groupId, d]));
  const groups: PlanGroup[] = clusters.map((cluster) => {
    const rowIds = cluster.map((r) => r.id).sort();
    const id = createHash('sha256').update(rowIds.join('\n')).digest('hex').slice(0, 24);
    const decision = decisions.get(id);
    const incoming: Partial<Record<keyof Values, ValueSource[]>> = {};
    for (const row of cluster) for (const field of PERSON_FIELDS) incoming[field.key] = [...(incoming[field.key] ?? []), ...(row.values[field.key] ?? [])];
    const values: Values = Object.fromEntries(PERSON_FIELDS.flatMap((f) => incoming[f.key]?.[0] ? [[f.key, incoming[f.key]![0].value]] : []));
    // Match on every source value, not just the first conflicting passport/phone.
    const candidateMap = new Map<string, ReturnType<CandidateIndex['find']>[number]>();
    for (const row of cluster) {
      for (const c of index.find(rowValues(row))) candidateMap.set(c.id, c);
      for (const field of ['passportNumber', 'phone'] as const) for (const v of row.values[field] ?? []) for (const c of index.find({ ...rowValues(row), [field]: v.value })) candidateMap.set(c.id, c);
    }
    if (decision?.personId && job.manualCandidateIds.includes(decision.personId)) for (const c of index.find(values, [decision.personId])) candidateMap.set(c.id, c);
    const projected = { ...values };
    for (const field of PERSON_FIELDS) {
      const chosen = decision?.fields?.[field.key];
      if (typeof chosen === 'string') {
        try { const value = normalizeValue(field.key, { text: chosen }); if (value) projected[field.key] = value; else delete projected[field.key]; } catch { /* Reported below. */ }
      } else if (chosen === null) delete projected[field.key];
    }
    // A corrected passport or name can introduce different candidates too.
    for (const c of index.find(projected)) candidateMap.set(c.id, c);
    const candidates = [...candidateMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    const errors = cluster.flatMap((r) => r.errors);
    const warnings = cluster.flatMap((r) => r.warnings);
    const skip = decision?.action === 'skip' || cluster.every((r) => r.excluded);
    let action: PlanGroup['action'] = skip ? 'skip' : decision?.action === 'new' ? 'new' : 'unresolved';
    let target: PersonSnapshot | null = null;
    if (!skip && decision?.action === 'existing') {
      target = candidates.find((c) => c.id === decision.personId) ?? null;
      if (target) action = 'existing'; else errors.push('Выбранная карточка не входит в доступные кандидаты. Найдите её вручную.');
    } else if (!skip && (!decision || decision.action === 'auto')) {
      if (!candidates.length) action = 'new';
      else if (candidates.length === 1 && candidates[0].compatible) { target = candidates[0]; action = 'existing'; }
    }
    if (cluster.some((r) => !fullIdentity(values, rowValues(r))) && cluster.length > 1 && !decision?.action?.match(/^(new|existing)$/)) action = 'unresolved';
    if (cluster.some((r) => hasInitials(rowValues(r))) && (!decision || decision.action === 'auto')) action = 'unresolved';
    const changes: FieldChange[] = PERSON_FIELDS.map((field) => {
      const proposals = incoming[field.key] ?? [];
      const unique = [...new Map(proposals.map((v) => [compareKey(field.key, v.value), v])).values()];
      const current = target?.values[field.key] ?? null;
      const chosen = decision?.fields?.[field.key];
      const conflict = unique.length > 1 || (!!current && unique.some((v) => compareKey(field.key, current) !== compareKey(field.key, v.value)));
      let value: string | null = unique[0]?.value ?? current;
      let resolved = !conflict;
      let kind: FieldChange['kind'] = conflict ? 'conflict' : !unique.length || (current && compareKey(field.key, current) === compareKey(field.key, value ?? '')) ? 'same' : 'addition';
      if (kind === 'same' && current) value = current;
      if (chosen !== undefined) {
        try { value = chosen === null ? current : normalizeValue(field.key, { text: chosen }) || current; resolved = true; kind = value === current ? 'kept' : current ? 'replacement' : 'addition'; }
        catch (err) { errors.push(`${field.label}: ${(err as Error).message}`); resolved = false; }
      }
      return { key: field.key, current, incoming: proposals, value: value ?? null, kind, resolved };
    });
    if (action === 'new') {
      for (const key of ['lastName', 'firstName'] as const) if (!changes.find((c) => c.key === key)?.value) errors.push(key === 'lastName' ? 'Фамилия обязательна для новой карточки.' : 'Имя обязательно для новой карточки.');
    }
    const ready = action === 'skip' || (action !== 'unresolved' && !errors.length && !warnings.length && changes.every((c) => c.resolved));
    const restore = action === 'existing' && !!target?.deletedAt && !!decision?.restore;
    const status: PlanGroup['status'] = action === 'skip' ? 'skipped' : errors.length ? 'error' : !ready ? 'conflict' : action === 'new' ? 'new' : restore || changes.some((c) => c.value !== c.current && c.value !== null) ? 'addition' : 'same';
    return { id, rowIds, sources: cluster.flatMap((r) => r.sources), values, candidates, target, action, status, changes, errors, warnings, ready, restore, candidateSignature: candidateSignature(candidates) };
  });
  // Same target in two groups must be resolved as one plan; never silently apply two competing writes.
  const targets = new Map<string, PlanGroup[]>();
  for (const group of groups) if (group.target && group.action !== 'skip') targets.set(group.target.id, [...(targets.get(group.target.id) ?? []), group]);
  for (const list of targets.values()) if (list.length > 1) for (const g of list) { g.errors.push('Несколько групп изменяют одну карточку. Объедините строки или исключите лишнюю группу.'); g.ready = false; g.status = 'error'; }
  const names = new Map<string, PlanGroup[]>();
  for (const group of groups) { const key = nameIdentity(group.values); if (key && group.action !== 'skip') names.set(key, [...(names.get(key) ?? []), group]); }
  for (const list of names.values()) if (list.length > 1) for (const g of list) if (!decisions.has(g.id) || decisions.get(g.id)?.action === 'auto') { g.warnings.push('В пакете есть отдельные группы с таким же ФИО. Явно выберите создание или существующую карточку.'); g.ready = false; g.status = 'conflict'; }
  const summary: Plan['summary'] = { new: 0, addition: 0, same: 0, conflict: 0, error: 0, skipped: 0 };
  for (const group of groups) summary[group.status]++;
  return { version: job.revision, groups, summary, ready: groups.filter((g) => g.ready && g.action !== 'skip').length, blocked: groups.filter((g) => !g.ready).length };
}

export function planIsCurrent(old: Plan, fresh: Plan): boolean {
  if (old.groups.length !== fresh.groups.length) return false;
  return old.groups.every((group, i) => {
    const other = fresh.groups[i];
    return group.id === other.id && (group.action === 'skip' || (group.candidateSignature === other.candidateSignature && JSON.stringify(group.target) === JSON.stringify(other.target)));
  });
}

export function validateDecision(decision: Decision, plan: Plan) {
  const group = plan.groups.find((g) => g.id === decision.groupId);
  return !!group && (decision.action !== 'existing' || !!decision.personId);
}
