import { createHash } from 'node:crypto';
import { compareKey, hasInitials, nameKey } from './normalize';
import type { Candidate, ImportRow, PersonSnapshot, Values } from './types';

export const rowValues = (row: ImportRow): Values => Object.fromEntries(Object.entries(row.values).map(([key, values]) => [key, values?.[0]?.value ?? ''])) as Values;
export const nameIdentity = (v: Values) => v.lastName && v.firstName ? `${nameKey(v.lastName)}|${nameKey(v.firstName)}` : '';
export function compatible(a: Values, b: Values): boolean {
  return (['passportNumber', 'birthDate', 'middleName'] as const).every((key) => !a[key] || !b[key] || compareKey(key, a[key]!) === compareKey(key, b[key]!));
}
export function fullIdentity(a: Values, b: Values): boolean {
  return !!nameIdentity(a) && nameIdentity(a) === nameIdentity(b) && (!a.middleName || !b.middleName || nameKey(a.middleName) === nameKey(b.middleName));
}
function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}
const append = (map: Map<string, PersonSnapshot[]>, key: string, person: PersonSnapshot) => { if (key) { const list = map.get(key) ?? []; list.push(person); map.set(key, list); } };
function surnameKeys(surname: string): Set<string> {
  const keys = new Set([surname]);
  // Exact matching remains available for all lengths; bounded fuzzy names use
  // deletion signatures, including deletions/substitutions in the first letters.
  if (surname.length <= 80) for (let i = 0; i < surname.length; i++) keys.add(surname.slice(0, i) + surname.slice(i + 1));
  return keys;
}
export class CandidateIndex {
  private passport = new Map<string, PersonSnapshot[]>();
  private surname = new Map<string, PersonSnapshot[]>();
  private phone = new Map<string, PersonSnapshot[]>();
  private byId = new Map<string, PersonSnapshot>();
  constructor(people: PersonSnapshot[]) {
    for (const person of people) {
      this.byId.set(person.id, person);
      append(this.passport, compareKey('passportNumber', person.values.passportNumber ?? ''), person);
      append(this.phone, compareKey('phone', person.values.phone ?? ''), person);
      const surname = nameKey(person.values.lastName ?? '');
      for (const key of surnameKeys(surname)) append(this.surname, key, person);
    }
  }
  find(values: Values, manualIds: string[] = []): Candidate[] {
    const candidates = new Map<string, Candidate>();
    const add = (person: PersonSnapshot, reason: string) => {
      const found = candidates.get(person.id);
      if (found) { if (!found.reasons.includes(reason)) found.reasons.push(reason); return; }
      candidates.set(person.id, { ...person, reasons: [reason], compatible: !hasInitials(values) && !hasInitials(person.values) && fullIdentity(values, person.values) && compatible(values, person.values) && !person.deletedAt });
    };
    const passport = compareKey('passportNumber', values.passportNumber ?? '');
    if (passport) for (const p of this.passport.get(passport) ?? []) add(p, fullIdentity(values, p.values) ? 'Совпадает паспорт' : 'Паспорт совпадает, ФИО различаются');
    const surname = nameKey(values.lastName ?? '');
    const surnameCandidates = new Map<string, PersonSnapshot>();
    for (const key of surnameKeys(surname)) for (const person of this.surname.get(key) ?? []) surnameCandidates.set(person.id, person);
    for (const person of surnameCandidates.values()) {
      const p = person.values;
      if (!near(surname, nameKey(p.lastName ?? ''))) continue;
      const first = nameKey(values.firstName ?? '').replace(/\.$/, '');
      const other = nameKey(p.firstName ?? '');
      if (!first || (first.length === 1 ? first !== other[0] : !near(first, other))) continue;
      add(person, fullIdentity(values, p) ? 'Совпадают ФИО' : 'Близкое или неполное ФИО');
    }
    const phone = compareKey('phone', values.phone ?? '');
    if (phone) for (const p of this.phone.get(phone) ?? []) add(p, 'Совпадает телефон');
    for (const id of manualIds) { const p = this.byId.get(id); if (p) add(p, 'Выбран вручную'); }
    return [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
export function candidateSignature(candidates: Candidate[]): string {
  return createHash('sha256').update(JSON.stringify(candidates.map(({ id, values, updatedAt, deletedAt }) => ({ id, values, updatedAt, deletedAt })))).digest('hex');
}

export function groupRows(rows: ImportRow[], separateIds: Set<string>, manualMerges = new Map<string, string>()): ImportRow[][] {
  const groups: ImportRow[][] = [];
  const nameGroups = new Map<string, number[]>();
  const passportGroups = new Map<string, number[]>();
  const sorted = [...rows].sort((a, b) => {
    const weight = (r: ImportRow) => Number(!!r.values.passportNumber?.length) * 2 + Number(!!r.values.birthDate?.length);
    return weight(b) - weight(a) || a.id.localeCompare(b.id);
  });
  for (const row of sorted) {
    const value = rowValues(row);
    const name = nameIdentity(value);
    const passport = compareKey('passportNumber', value.passportNumber ?? '');
    const matches = new Set<number>();
    if (!row.excluded && !row.errors.length && !separateIds.has(row.id)) {
      for (const index of new Set([...(nameGroups.get(name) ?? []), ...(passport ? passportGroups.get(passport) ?? [] : [])])) {
        const group = groups[index];
        if (group.some((r) => r.excluded || separateIds.has(r.id))) continue;
        if (group.every((r) => {
          const other = rowValues(r);
          return (passport && other.passportNumber && passport === compareKey('passportNumber', other.passportNumber)) || (fullIdentity(value, other) && compatible(value, other));
        })) matches.add(index);
      }
    }
    if (matches.size === 1) groups[[...matches][0]].push(row);
    else {
      const index = groups.length;
      groups.push([row]);
      if (name) nameGroups.set(name, [...(nameGroups.get(name) ?? []), index]);
      if (passport) passportGroups.set(passport, [...(passportGroups.get(passport) ?? []), index]);
      if (matches.size > 1) row.warnings.push('Строка подходит нескольким людям пакета. Выберите карточку вручную или создайте отдельную.');
    }
  }
  if (!manualMerges.size) return groups;
  const parents = groups.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parents[root] !== root) root = parents[root];
    while (parents[i] !== i) { const next = parents[i]; parents[i] = root; i = next; }
    return root;
  };
  const groupFor = new Map<string, number>();
  groups.forEach((group, i) => group.filter((r) => !r.excluded).forEach((row) => groupFor.set(row.id, i)));
  for (const [from, to] of manualMerges) {
    const a = groupFor.get(from), b = groupFor.get(to);
    if (a !== undefined && b !== undefined) parents[find(a)] = find(b);
  }
  const merged = new Map<number, ImportRow[]>();
  groups.forEach((group, i) => merged.set(find(i), [...(merged.get(find(i)) ?? []), ...group]));
  return [...merged.values()];
}
