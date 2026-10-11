import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../lib/batch-import/plan';
import { JobStore } from '../lib/batch-import/jobs';
import type { ColumnKey, Job, PersonSnapshot, Table, Values } from '../lib/batch-import/types';

export function table(id: string, columns: ColumnKey[], data: string[][]): Table {
  return { id, fileName: `${id}.xlsx`, name: 'Лист', rows: [columns.map(String), ...data].map((cells, i) => ({ number: i + 1, cells: cells.map((text) => ({ text })) })), warnings: [], selection: { tableId: id, included: true, headerStart: 1, headerEnd: 1, columns } };
}
function job(tables: Table[]): Job { return new JobStore().create('owner', tables); }
const person = (id: string, values: Values, deletedAt: string | null = null): PersonSnapshot => ({ id, values, updatedAt: '2026-01-01T00:00:00Z', deletedAt });
test('phone and passport sources merge; normalization matches without changing source spelling', () => {
  const data = job([table('phone', ['fullName', 'phone'], [['Семёнов Иван Иванович', '+70000000000']]), table('passport', ['fullName', 'passportNumber'], [['Семенов Иван Иванович', '0011 000222']])]);
  const plan = buildPlan(data, []); assert.equal(plan.groups.length, 1); assert.equal(plan.ready, 1);
  assert.equal(plan.groups[0].rowIds.length, 2); assert.equal(plan.groups[0].changes.find((c) => c.key === 'passportNumber')?.value, '0011 000222');
});
test('two phones conflict, and choosing one preserves the single phone field', () => {
  const data = job([table('a', ['fullName', 'phone'], [['Иванов Иван Иванович', '111'], ['Иванов Иван Иванович', '222']])]);
  let plan = buildPlan(data, []); assert.equal(plan.blocked, 1);
  data.decisions = [{ groupId: plan.groups[0].id, action: 'new', fields: { phone: '222' } }];
  plan = buildPlan(data, []); assert.equal(plan.ready, 1); assert.equal(plan.groups[0].changes.find((c) => c.key === 'phone')?.value, '222');
});
test('homonyms, identity mismatch and archived candidates require a decision', () => {
  const data = job([table('a', ['fullName', 'passportNumber'], [['Иванов Иван Иванович', '123']])]);
  const people = [person('a', { lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович' }), person('b', { lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович' })];
  assert.equal(buildPlan(data, people).blocked, 1);
  assert.equal(buildPlan(data, [person('c', { lastName: 'Петров', firstName: 'Пётр', passportNumber: '123' })]).blocked, 1);
  const archive = person('d', { lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович' }, '2025-01-01T00:00:00Z');
  let plan = buildPlan(data, [archive]); assert.equal(plan.blocked, 1);
  data.decisions = [{ groupId: plan.groups[0].id, action: 'existing', personId: 'd' }];
  plan = buildPlan(data, [archive]); assert.equal(plan.ready, 1); assert.equal(plan.groups[0].restore, false);
});
test('empty input never clears existing fields; different filled values need explicit choice', () => {
  const data = job([table('a', ['lastName', 'firstName', 'phone'], [['Иванов', 'Иван', '']])]);
  const p = person('p', { lastName: 'Иванов', firstName: 'Иван', phone: '123' });
  let plan = buildPlan(data, [p]); assert.equal(plan.ready, 1); assert.equal(plan.groups[0].status, 'same');
  assert.equal(plan.groups[0].changes.find((c) => c.key === 'phone')?.value, '123');
  data.tables[0].rows[1].cells[2].text = '456'; plan = buildPlan(data, [p]); assert.equal(plan.blocked, 1);
});
test('equal normalized values preserve the database spelling and formatting', () => {
  const data = job([table('a', ['fullName', 'passportNumber', 'phone'], [['Семенов Иван Иванович', '0011000222', '+7 000 000 00 00']])]);
  const p = person('p', { lastName: 'Семёнов', firstName: 'Иван', middleName: 'Иванович', passportNumber: '0011 000222', phone: '+70000000000' });
  const group = buildPlan(data, [p]).groups[0];
  assert.equal(group.status, 'same'); assert.equal(group.changes.find((c) => c.key === 'lastName')?.value, 'Семёнов');
  assert.equal(group.changes.find((c) => c.key === 'passportNumber')?.value, '0011 000222');
});
test('birth/passport contradictions do not collapse same-name people or bridge weak rows', () => {
  const data = job([table('a', ['fullName', 'passportNumber'], [['Иванов Иван Иванович', '111'], ['Иванов Иван Иванович', '222'], ['Иванов Иван Иванович', '']])]);
  const plan = buildPlan(data, []); assert.equal(plan.groups.length, 3); assert.equal(plan.blocked, 3);
});
test('manual row merging keeps passport contradictions visible for explicit resolution', () => {
  const data = job([table('a', ['fullName', 'passportNumber'], [['Иванов Иван Иванович', '111'], ['Иванов Иван Иванович', '222']])]);
  data.rowEdits = [{ rowId: 'a:row:3', mergeWith: 'a:row:2' }];
  let plan = buildPlan(data, []); assert.equal(plan.groups.length, 1); assert.equal(plan.blocked, 1);
  data.decisions = [{ groupId: plan.groups[0].id, action: 'new', fields: { passportNumber: '222' } }];
  plan = buildPlan(data, []); assert.equal(plan.ready, 1); assert.equal(plan.groups[0].changes.find((c) => c.key === 'passportNumber')?.value, '222');
});
test('initials require review and totals are excluded without becoming people', () => {
  const data = job([table('a', ['lastName', 'firstName'], [['Иванов', 'И.'], ['Итого', '10']])]);
  const plan = buildPlan(data, []);
  assert.equal(plan.blocked, 1); assert.equal(plan.summary.skipped, 1);
  assert.ok(plan.groups.find((g) => g.status === 'conflict')?.warnings.some((w) => w.includes('Инициалы')));
});
test('review regression: a notes-only edit leaves both duplicated phone proposals unresolved', () => {
  const data = job([table('a', ['lastName', 'firstName', 'phone', 'phone', 'notes'], [['Иванов', 'Иван', '111', '222', 'Старое']])]);
  data.rowEdits = [{ rowId: 'a:row:2', values: { notes: 'Исправлено' } }];
  const plan = buildPlan(data, []); const phone = plan.groups[0].changes.find((c) => c.key === 'phone')!;
  assert.deepEqual(phone.incoming.map((v) => v.value), ['111', '222']); assert.equal(phone.resolved, false); assert.equal(plan.ready, 0);
});
test('review regression: duplicate split-passport mappings must not silently overwrite earlier columns', () => {
  for (const [columns, values] of [
    [['lastName', 'firstName', 'passportSeries', 'passportSeries', 'passportDigits'], ['Иванов', 'Иван', '0011', '0022', '123456']],
    [['lastName', 'firstName', 'passportSeries', 'passportDigits', 'passportDigits'], ['Иванов', 'Иван', '0011', '123456', '654321']],
  ] as [ColumnKey[], string[]][]) {
    const plan = buildPlan(job([table('a', columns, [values])]), []);
    assert.equal(plan.ready, 0); assert.equal(plan.blocked, 1);
    assert.ok(plan.groups[0].errors.some((e) => /повтор|несколько/i.test(e)));
  }
});
test('review regression: initials in separate columns still require an identity choice after warning acknowledgement', () => {
  const data = job([table('a', ['lastName', 'firstName', 'phone'], [['Иванов', 'И.', '111']])]);
  const p = person('p', { lastName: 'Иванов', firstName: 'И.' });
  data.rowEdits = [{ rowId: 'a:row:2', acknowledgeWarnings: true }];
  let plan = buildPlan(data, [p]); assert.equal(plan.ready, 0); assert.equal(plan.groups[0].action, 'unresolved');
  data.decisions = [{ groupId: plan.groups[0].id, action: 'existing', personId: p.id }];
  plan = buildPlan(data, [p]); assert.equal(plan.ready, 1);
});
test('compact initials stay unresolved even after acknowledging a full-name warning', () => {
  for (const firstName of ['И.И.', 'И.И', 'И. И.']) {
    for (const combined of [false, true]) {
      const columns: ColumnKey[] = combined ? ['fullName', 'passportNumber'] : ['lastName', 'firstName', 'passportNumber'];
      const data = job([table('a', columns, [combined ? [`Иванов ${firstName}`, '0011 222333'] : ['Иванов', firstName, '0011 222333']])]);
      data.rowEdits = [{ rowId: 'a:row:2', acknowledgeWarnings: true }];
      const p = person('p', { lastName: 'Иванов', firstName: combined && firstName.includes(' ') ? 'И.' : firstName, ...(combined && firstName.includes(' ') ? { middleName: 'И.' } : {}) });
      let plan = buildPlan(data, [p]); assert.equal(plan.ready, 0, firstName); assert.equal(plan.groups[0].action, 'unresolved');
      data.decisions = [{ groupId: plan.groups[0].id, action: 'existing', personId: p.id }];
      plan = buildPlan(data, [p]); assert.equal(plan.ready, 1);
    }
  }
});
test('review regression: surname substitutions in the first two letters remain possible duplicates', () => {
  for (const surname of ['Еванов', 'Иаанов', 'Ванов', 'Аиванов']) {
    const data = job([table('a', ['lastName', 'firstName'], [[surname, 'Иван']])]);
    const plan = buildPlan(data, [person('p', { lastName: 'Иванов', firstName: 'Иван' })]);
    assert.equal(plan.groups[0].candidates.length, 1, surname); assert.equal(plan.ready, 0, surname);
  }
});
test('review regression: formula-error rows with blank displayed text are not discarded as repeated headers', () => {
  const source = table('a', ['lastName', 'firstName', 'phone'], [['', '', '']]);
  source.rows[1].cells = source.rows[1].cells.map((c) => ({ ...c, error: 'Формула не имеет сохранённого результата' }));
  const plan = buildPlan(job([source]), []); assert.equal(plan.groups.length, 1); assert.equal(plan.blocked, 1); assert.equal(plan.groups[0].errors.filter((error) => error.includes('Формула')).length, 3);
});
test('manual candidate must be registered; invalid names can be fixed and a group can be excluded', () => {
  const data = job([table('a', ['lastName', 'firstName', 'birthDate'], [['Иванов', '', '31.02.2000']])]);
  let plan = buildPlan(data, []); assert.equal(plan.blocked, 1);
  data.rowEdits = [{ rowId: 'a:row:2', values: { firstName: 'Иван', birthDate: '2000-02-29' } }];
  plan = buildPlan(data, []); assert.equal(plan.ready, 1);
  const p = person('manual', { lastName: 'Сидоров', firstName: 'Пётр' });
  data.decisions = [{ groupId: plan.groups[0].id, action: 'existing', personId: p.id }];
  assert.equal(buildPlan(data, [p]).ready, 0);
  data.manualCandidateIds = [p.id]; plan = buildPlan(data, [p]); assert.equal(plan.groups[0].candidates[0].id, p.id);
  data.decisions = [{ groupId: plan.groups[0].id, action: 'skip' }]; assert.equal(buildPlan(data, [p]).blocked, 0);
});
test('job ownership, expiry, cancellation and bounded capacity are enforced', () => {
  let now = 0; const store = new JobStore(() => now); const created = store.create('owner', []);
  assert.throws(() => store.get(created.id, 'other'), /сессии/);
  now = created.expiresAt + 1; assert.throws(() => store.get(created.id, 'owner'), /истекло/);
  const active = store.create('owner', []); store.clearOwner('owner'); assert.throws(() => store.get(active.id, 'owner'), /отменено/);
  for (let i = 0; i < 8; i++) store.create('owner', []);
  assert.throws(() => store.create('owner', []), /много/);
});
