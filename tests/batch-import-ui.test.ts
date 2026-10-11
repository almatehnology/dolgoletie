import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { ReactReduxContext } from 'react-redux';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { ImportWizard } from '../components/batch-import/import-wizard';
import { RowEditor } from '../components/batch-import/row-editor';
import { buildPlan } from '../lib/batch-import/plan';
import { extractRows } from '../lib/batch-import/rows';
import { JobStore, jobView } from '../lib/batch-import/jobs';
import type { JobView, RowEdit, Table } from '../lib/batch-import/types';

// Exercise the components' real event handlers with controlled hook state.
// No DOM/browser acceptance is implied; network and sessionStorage are fixtures.
type Element = React.ReactElement<Record<string, any>>;
function elements(node: React.ReactNode): Element[] {
  if (!React.isValidElement(node)) return Array.isArray(node) ? node.flatMap(elements) : [];
  const element = node as Element; return [element, ...elements(element.props.children)];
}
function label(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(label).join('');
  return React.isValidElement(node) ? label((node as Element).props.children) : '';
}
function harness(render: () => React.ReactNode) {
  const slots: any[] = []; const effects: (() => unknown)[] = []; let cursor = 0;
  const dispatcher = {
    useState(initial: any) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (value: any) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    },
    useEffect(fn: () => unknown, deps: unknown[]) {
      const slot = cursor++;
      if (!(slot in slots) || !deps || deps.some((v, i) => slots[slot][i] !== v)) { slots[slot] = deps; effects.push(fn); }
    },
    useContext(context: any) {
      if (context === AppRouterContext) return { refresh() {} };
      if (context === ReactReduxContext) return { store: { dispatch() {} } };
      return context._currentValue;
    },
    useDebugValue() {},
  };
  return {
    render() {
      cursor = 0;
      const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const before = internals.H; const previousReact = (globalThis as any).React;
      internals.H = dispatcher; (globalThis as any).React = React;
      try { return elements(render()); } finally { internals.H = before; (globalThis as any).React = previousReact; }
    },
    async effects() { effects.splice(0).forEach((effect) => effect()); await new Promise<void>((resolve) => setImmediate(resolve)); },
  };
}
function fixture() {
  const table: Table = { id: 'a', fileName: 'a.xlsx', name: 'Лист', rows: [
    { number: 1, cells: ['Фамилия', 'Имя', 'Телефон', 'Телефон', 'Примечания'].map((text) => ({ text })) },
    { number: 2, cells: ['Иванов', 'Иван', '111', '222', 'До правки'].map((text) => ({ text })) },
  ], warnings: [], selection: { tableId: 'a', included: true, headerStart: 1, headerEnd: 1, columns: ['lastName', 'firstName', 'phone', 'phone', 'notes'] } };
  return new JobStore().create('synthetic-ui', [table]);
}
test('review P1 regression: the actual row editor changes notes without choosing a duplicated phone', () => {
  const job = fixture(); const row = extractRows(job.tables)[0]; let payload: RowEdit | undefined;
  const view = harness(() => RowEditor({ row, mergeOptions: [], onSave(edit) { payload = edit; } }));
  let tree = view.render();
  const notes = tree.find((e) => e.type === 'label' && label(e) === 'Примечания')!;
  elements(notes.props.children).find((e) => e.type === 'input')!.props.onChange({ target: { value: 'Исправлены только заметки' } });
  tree = view.render(); tree.find((e) => e.type === 'button' && label(e) === 'Пересчитать с исправлениями')!.props.onClick();
  assert.deepEqual(payload!.values, { notes: 'Исправлены только заметки' });
  job.rowEdits = [payload!]; const plan = buildPlan(job, []);
  assert.deepEqual(plan.groups[0].changes.find((c) => c.key === 'phone')!.incoming.map((v) => v.value), ['111', '222']);
  assert.equal(plan.ready, 0);
});
function storageFixture(t: import('node:test').TestContext) {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) };
  const old = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true });
  t.after(() => { if (old) Object.defineProperty(globalThis, 'sessionStorage', old); else delete (globalThis as any).sessionStorage; });
  return storage;
}
test('review P1 regression: reload after failed GET cannot turn receipt recovery into the first write', async (t) => {
  storageFixture(t);
  const job = fixture(); job.plan = null; const uploaded: JobView = jobView(job); let writes = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/apply')) { writes++; return Response.json({ created: 1, updated: 0, unchanged: 0, skipped: 0, restored: 0, people: [] }); }
    if (init?.method === 'POST' && String(url).endsWith('/jobs')) return Response.json(uploaded, { status: 201 });
    return Response.json({ error: { code: 'SYNTHETIC_GET_FAILURE', message: 'Synthetic GET failure' } }, { status: 500 });
  });
  const first = harness(ImportWizard); let tree = first.render(); await first.effects();
  tree.find((e) => e.type === 'input' && e.props.type === 'file')!.props.onChange({ target: { files: [new File(['fixture'], 'a.xlsx')] } });
  tree = first.render(); await tree.find((e) => e.type === 'button' && label(e) === 'Разобрать файлы')!.props.onClick();
  assert.equal(writes, 0);
  const reloaded = harness(ImportWizard); reloaded.render(); await reloaded.effects(); tree = reloaded.render();
  const recover = tree.find((e) => e.type === 'button' && label(e) === 'Получить результат предыдущего подтверждения');
  if (recover) await recover.props.onClick();
  assert.equal(writes, 0, 'Getting a previous result must never POST the first confirmation');
});
test('a sent confirmation is persisted only after dispatch and reload recovery uses a bodyless GET', async (t) => {
  const storage = storageFixture(t); const job = fixture(); job.tables[0].rows[1].cells[3].text = '111';
  const uploaded = jobView({ ...job, plan: null }); job.revision++; job.plan = buildPlan(job, []); const preview = jobView(job);
  let writes = 0, reads = 0;
  const result = { created: 1, updated: 0, unchanged: 0, skipped: 0, restored: 0, people: [] };
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/jobs')) return Response.json(uploaded, { status: 201 });
    if (String(url).endsWith('/plan')) return Response.json(preview);
    if (String(url).endsWith('/apply')) {
      assert.equal(storage.getItem('tdb-batch-import-confirmation'), null, 'Pending must not precede dispatch');
      assert.equal(init?.method, 'POST'); assert.equal(JSON.parse(String(init?.body)).confirm, true);
      writes++; throw new Error('Synthetic loss of response after confirmation was sent');
    }
    if (String(url).includes('/receipt?')) { assert.equal(init?.method ?? 'GET', 'GET'); assert.equal(init?.body, undefined); reads++; return Response.json(result); }
    return Response.json({ error: { code: 'GET_FAILED', message: 'Synthetic GET failure' } }, { status: 500 });
  });
  const first = harness(ImportWizard); let tree = first.render(); await first.effects();
  tree.find((e) => e.type === 'input' && e.props.type === 'file')!.props.onChange({ target: { files: [new File(['fixture'], 'a.xlsx')] } });
  tree = first.render(); await tree.find((e) => e.type === 'button' && label(e) === 'Разобрать файлы')!.props.onClick();
  assert.equal(storage.getItem('tdb-batch-import-confirmation'), null);
  tree = first.render(); await tree.find((e) => e.type === 'button' && label(e) === 'Показать план изменений')!.props.onClick();
  assert.equal(storage.getItem('tdb-batch-import-confirmation'), null);
  tree = first.render(); const confirmation = tree.find((e) => e.type === 'label' && label(e).includes('Я проверил(а) итоговый план'))!;
  elements(confirmation.props.children).find((e) => e.type === 'input')!.props.onChange({ target: { checked: true } });
  tree = first.render(); await tree.find((e) => e.type === 'button' && label(e) === 'Подтвердить импорт')!.props.onClick();
  assert.equal(writes, 1); assert.deepEqual(JSON.parse(storage.getItem('tdb-batch-import-confirmation')!), { id: job.id, version: job.revision });
  const reloaded = harness(ImportWizard); reloaded.render(); await reloaded.effects(); tree = reloaded.render();
  await tree.find((e) => e.type === 'button' && label(e) === 'Получить результат предыдущего подтверждения')!.props.onClick();
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(storage.getItem('tdb-batch-import-confirmation'), null);
});
test('a later notes edit retains an earlier explicit row override without touching other fields', () => {
  const job = fixture(); const initial: RowEdit = { rowId: 'a:row:2', values: { firstName: 'Пётр' } };
  const row = extractRows(job.tables, [initial])[0]; let payload: RowEdit | undefined;
  const view = harness(() => RowEditor({ row, initial, mergeOptions: [], onSave(edit) { payload = edit; } }));
  let tree = view.render(); const notes = tree.find((e) => e.type === 'label' && label(e) === 'Примечания')!;
  elements(notes.props.children).find((e) => e.type === 'input')!.props.onChange({ target: { value: 'Новая заметка' } });
  tree = view.render(); tree.find((e) => e.type === 'button' && label(e) === 'Пересчитать с исправлениями')!.props.onClick();
  assert.deepEqual(payload!.values, { firstName: 'Пётр', notes: 'Новая заметка' });
  job.rowEdits = [payload!]; const plan = buildPlan(job, []); assert.equal(plan.groups[0].changes.find((c) => c.key === 'phone')!.resolved, false);
});
