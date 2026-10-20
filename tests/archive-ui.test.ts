import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { ArchiveTable, type ArchiveTableProps } from '../components/archive/archive-table';
import type { ArchiveRequest } from '../lib/archive/model';

type Element = React.ReactElement<Record<string, any>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return React.isValidElement(node) ? text((node as Element).props.children) : '';
}
function harness(props: ArchiveTableProps) {
  const slots: any[] = []; let cursor = 0;
  const dispatcher = {
    useState(initial: any) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (value: any) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    },
    useRef(initial: any) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
  };
  return () => {
    cursor = 0;
    const internal = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previous = internal.H; const previousReact = (globalThis as any).React;
    internal.H = dispatcher; (globalThis as any).React = React;
    try { return elements(ArchiveTable(props)); }
    finally { internal.H = previous; (globalThis as any).React = previousReact; }
  };
}
const byLabel = (tree: Element[], label: string) => tree.find((node) => node.props['aria-label'] === label)!;
const button = (tree: Element[], label: string) => tree.find((node) => node.type === 'button' && text(node) === label)!;
function fixture(entity: ArchiveRequest['entity']): ArchiveTableProps {
  return { entity, items: [{ id: 'one', label: 'Первая запись', details: ['Место', 'Дата'] }, { id: 'two', label: 'Вторая запись', details: ['Место', 'Дата'] }], headings: ['Запись', 'Место', 'Дата'], page: 1, pageSize: 200, total: 202, loading: false, loadError: false, onReload() {}, onPage() {}, onAction: async (request) => ({ ...request, count: request.ids.length }) };
}
function confirmFixture(t: import('node:test').TestContext) {
  const messages: string[] = []; let accepted = false;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm(message: string) { messages.push(message); return accepted; } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  return { messages, accept() { accepted = true; } };
}

// Real component event handlers with hook state; this is not browser/DOM proof.
for (const entity of ['people', 'events'] as const) for (const action of ['restore', 'delete'] as const) {
  test(`${entity} ${action}: checkboxes, count, cancel, confirmation and immediate row removal`, async (t) => {
    const confirmation = confirmFixture(t);
    const props = fixture(entity); const calls: ArchiveRequest[] = [];
    props.onAction = async (request) => { calls.push(request); return { ...request, count: request.ids.length }; };
    const render = harness(props);
    const label = action === 'restore' ? 'Восстановить выбранные' : 'Удалить выбранные навсегда';
    let tree = render();
    assert.equal(button(tree, label).props.disabled, true);
    byLabel(tree, 'Выбрать: Первая запись').props.onChange({ target: { checked: true } });
    tree = render();
    assert.ok(tree.some((node) => node.props.role === 'status' && text(node) === 'Выбрано: 1'));
    const partial = { indeterminate: false };
    byLabel(tree, 'Выбрать все записи на странице').props.ref(partial);
    assert.equal(partial.indeterminate, true);
    byLabel(tree, 'Выбрать все записи на странице').props.onChange({ target: { checked: true } });
    tree = render();
    assert.equal(byLabel(tree, 'Выбрать все записи на странице').props.checked, true);
    assert.equal(tree.filter((node) => node.type === 'tr' && node.props['aria-selected']).length, 2);
    await button(tree, label).props.onClick();
    assert.equal(calls.length, 0);
    assert.match(confirmation.messages[0], /\(2\)/);
    assert.match(confirmation.messages[0], /Первая запись/);
    if (action === 'delete') {
      assert.match(confirmation.messages[0], /Восстановление из архива станет недоступно/);
      assert.match(confirmation.messages[0], /История и оригиналы вложений сохраняются/);
    }
    confirmation.accept();
    await button(render(), label).props.onClick();
    assert.deepEqual(calls, [{ entity, action, ids: ['one', 'two'], confirm: true }]);
    tree = render();
    assert.equal(tree.filter((node) => node.type === 'tr' && node.props['aria-selected'] !== undefined).length, 0);
    assert.ok(tree.some((node) => node.props.role === 'status' && text(node) === 'Выбрано: 0'));
    assert.ok(tree.some((node) => node.props.role === 'status' && /записей: 2/.test(text(node))));
  });
}

test('single-row actions confirm count 1 and pending work blocks duplicate submissions', async (t) => {
  const confirmation = confirmFixture(t); confirmation.accept();
  const props = fixture('people'); let calls = 0; let finish!: () => void;
  props.onAction = async (request) => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); return { ...request, count: 1 }; };
  const render = harness(props);
  const first = byLabel(render(), 'Восстановить: Первая запись');
  const pending = first.props.onClick();
  await first.props.onClick();
  assert.equal(calls, 1);
  assert.match(confirmation.messages[0], /\(1\)/);
  assert.equal(byLabel(render(), 'Удалить навсегда: Вторая запись').props.disabled, true);
  assert.equal(button(render(), 'Далее').props.disabled, true);
  finish(); await pending;
  assert.equal(byLabel(render(), 'Выбрать: Первая запись'), undefined);
  assert.ok(byLabel(render(), 'Выбрать: Вторая запись'));
});

test('failed mutation keeps selection and rows, reports server error and permits reload/retry', async (t) => {
  const confirmation = confirmFixture(t); confirmation.accept();
  const props = fixture('events'); let reloads = 0;
  props.onReload = () => { reloads++; };
  props.onAction = async () => { throw { data: { error: { message: 'Архив изменился. Ничего не изменено.' } } }; };
  const render = harness(props);
  byLabel(render(), 'Выбрать: Первая запись').props.onChange({ target: { checked: true } });
  await button(render(), 'Удалить выбранные навсегда').props.onClick();
  const tree = render();
  assert.equal(byLabel(tree, 'Выбрать: Первая запись').props.checked, true);
  assert.ok(tree.some((node) => node.props.role === 'alert' && /Ничего не изменено/.test(text(node))));
  assert.equal(button(tree, 'Удалить выбранные навсегда').props.disabled, false);
  button(tree, 'Обновить').props.onClick(); assert.equal(reloads, 1);
  props.loading = true;
  assert.equal(button(render(), 'Удалить выбранные навсегда').props.disabled, true);
  props.loading = false; props.loadError = true;
  assert.equal(button(render(), 'Восстановить выбранные').props.disabled, true);
  assert.equal(render().some((node) => node.type === 'p' && text(node) === 'Архив пуст.'), false);
});

test('pagination is explicit and refreshed-away IDs cannot remain selected', () => {
  const props = fixture('people'); const pages: number[] = [];
  props.onPage = (page) => pages.push(page);
  const render = harness(props);
  byLabel(render(), 'Выбрать все записи на странице').props.onChange({ target: { checked: true } });
  props.items = props.items.slice(1);
  assert.ok(render().some((node) => node.props.role === 'status' && text(node) === 'Выбрано: 1'));
  button(render(), 'Далее').props.onClick(); assert.deepEqual(pages, [2]);
  props.items = []; props.page = 2; props.total = 200;
  assert.equal(button(render(), 'Назад').props.disabled, false);
  assert.equal(button(render(), 'Далее').props.disabled, true);
  assert.equal(button(render(), 'Восстановить выбранные').props.disabled, true);
});
