import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import type { PersonListItem } from '../lib/store/people-api';

// Exercise the actual picker handlers and mutation definition with controlled query state.
// This does not assert browser rendering or replace device acceptance.
type Element = React.ReactElement<Record<string, any>>;
type Query = { q: string; page: number; pageSize: number };
type Input = { eventId: string; input: { personIds: string[]; paymentStatus: string; prepaidAmount?: string; totalDue?: string } };
let directory: string;
let AddParticipants: typeof import('../components/events/add-participants')['AddParticipants'];
let query: Query;
let definition: { query: (input: Input) => unknown; invalidatesTags: (result: unknown, error: unknown, input: Input) => unknown[] };
let pageItems: PersonListItem[];
let total: number;
let fetching: boolean;
let queryError: boolean;
let loading: boolean;
let refetches: number;
let closed: number;
let sent: Input[];
let perform: () => Promise<unknown>;
const globals = globalThis as typeof globalThis & { participantsUiFixture?: any };
const previousFixture = globals.participantsUiFixture;

function person(id: string): PersonListItem {
  return { id, firstName: 'Иван', lastName: id, middleName: null, phone: null, passportNumber: null } as PersonListItem;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tdb-participants-ui-'));
  globals.participantsUiFixture = {
    query(args: Query) {
      query = args;
      return {
        currentData: fetching ? undefined : { items: pageItems, total, pageSize: 20, page: args.page },
        isFetching: fetching, isError: queryError, refetch() { refetches++; },
      };
    },
    inject(config: any) {
      definition = config.endpoints({ mutation: (value: unknown) => value }).addParticipants;
      return {
        useAddParticipantsMutation() {
          return [(input: Input) => { sent.push(input); return { unwrap: perform }; }, { isLoading: loading }];
        },
      };
    },
  };
  const queryFile = join(directory, 'query.cjs');
  const apiFile = join(directory, 'api.cjs');
  const controlsFile = join(directory, 'controls.cjs');
  await writeFile(queryFile, 'exports.useListPeopleQuery = (args) => globalThis.participantsUiFixture.query(args);\n');
  await writeFile(apiFile, 'exports.api = { injectEndpoints: (config) => globalThis.participantsUiFixture.inject(config) };\n');
  // HeroUI is ESM-only; lightweight controls leave this test focused on our handlers.
  await writeFile(controlsFile, "exports.Button = 'button'; exports.Modal = { Header: 'header', Heading: 'h2', CloseTrigger: 'close', Body: 'main', Footer: 'footer' };\n");
  const redirects = new Map<string, string>();
  redirects.set('@heroui/react', pathToFileURL(controlsFile).href);
  for (const [module, file] of [['lib/store/people-api', queryFile], ['lib/store/api', apiFile]]) {
    for (const specifier of [`@/${module}`, resolve(module), `${resolve(module)}.ts`, pathToFileURL(`${resolve(module)}.ts`).href]) {
      redirects.set(specifier, pathToFileURL(file).href);
    }
  }
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = redirects.get(specifier);
      if (target) return { url: target, shortCircuit: true };
      const result = nextResolve(specifier, context);
      return redirects.has(result.url) ? { url: redirects.get(result.url)!, shortCircuit: true } : result;
    },
  });
  try { ({ AddParticipants } = await import('../components/events/add-participants')); }
  finally { hooks.deregister(); }
});

beforeEach(() => {
  pageItems = [person('first'), person('second'), person('existing')];
  total = 45;
  fetching = queryError = loading = false;
  refetches = closed = 0;
  sent = [];
  perform = async () => ({ count: 2 });
});

after(async () => {
  if (previousFixture === undefined) delete globals.participantsUiFixture;
  else globals.participantsUiFixture = previousFixture;
  if (directory) await rm(directory, { recursive: true, force: true });
});

function elements(node: React.ReactNode): Element[] {
  if (!React.isValidElement(node)) return Array.isArray(node) ? node.flatMap(elements) : [];
  const element = node as Element;
  // Expand the stateless card so assertions inspect its real checkbox and label.
  if (typeof element.type === 'function' && element.type.name === 'PersonResultCard') {
    return [element, ...elements((element.type as (props: any) => React.ReactNode)(element.props))];
  }
  return [element, ...elements(element.props.children)];
}
function label(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(label).join('');
  return React.isValidElement(node) ? label((node as Element).props.children) : '';
}
function picker() {
  const slots: any[] = [];
  let cursor = 0;
  let existing = ['existing'];
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
  const render = () => {
    cursor = 0;
    const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previousDispatcher = internals.H;
    const previousReact = (globalThis as any).React;
    internals.H = dispatcher;
    (globalThis as any).React = React;
    try { return elements(AddParticipants({ eventId: 'event', existingPersonIds: existing, onClose() { closed++; } })); }
    finally { internals.H = previousDispatcher; (globalThis as any).React = previousReact; }
  };
  return {
    render,
    existing(ids: string[]) { existing = ids; },
    toggle(id: string) { render().find((element) => element.props.person?.id === id)!.props.onSelect(); },
    field(name: string, value: string) { render().find((element) => element.props.label === name)!.props.onChange(value); },
    button(text: string) { return render().find((element) => element.props.onPress && label(element) === text)!; },
    submit() { return render().find((element) => element.props.onPress && label(element).startsWith('Добавить выбранных'))!; },
  };
}

test('checkboxes exclude existing participants and count reflects toggling and removal', () => {
  const view = picker();
  assert.equal(view.submit().props.isDisabled, true);
  assert.equal(view.render().filter((element) => element.props.type === 'checkbox').length, 2);
  assert.equal(view.render().some((element) => element.props.person?.id === 'existing'), false);
  view.toggle('first');
  view.toggle('second');
  assert.equal(label(view.submit()), 'Добавить выбранных (2)');
  assert.equal(view.render().filter((element) => element.props.type === 'checkbox' && element.props.checked).length, 2);
  view.render().find((element) => element.props['aria-label'] === 'Убрать из выбора: first Иван')!.props.onPress();
  assert.equal(label(view.submit()), 'Добавить выбранных (1)');
  view.toggle('second');
  assert.equal(view.submit().props.isDisabled, true);
});

test('selection persists across pages and search, search returns to page one, and one POST contains all IDs', async () => {
  const view = picker();
  view.toggle('first');
  view.button('Далее').props.onPress();
  pageItems = [person('third')];
  view.toggle('third');
  assert.equal(query.page, 2);
  view.field('Поиск человека', 'Петров');
  pageItems = [person('fourth')];
  view.toggle('fourth');
  assert.deepEqual(query, { q: 'Петров', page: 1, pageSize: 20 });
  view.field('Предоплата', ' 10 ');
  view.field('Итого', ' 100 ');
  view.button('Предоплата').props.onPress();
  assert.equal(label(view.submit()), 'Добавить выбранных (3)');
  await view.submit().props.onPress();
  assert.equal(closed, 1);
  assert.deepEqual(sent, [{ eventId: 'event', input: {
    personIds: ['first', 'third', 'fourth'], paymentStatus: 'PREPAID', prepaidAmount: '10', totalDue: '100',
  } }]);
  assert.deepEqual(definition.query(sent[0]), {
    url: 'events/event/participants', method: 'POST', body: sent[0].input,
  });
  assert.deepEqual(definition.invalidatesTags({}, undefined, sent[0]), [
    { type: 'Event', id: 'event' }, { type: 'Events', id: 'LIST' }, { type: 'People', id: 'LIST' },
    ...['first', 'third', 'fourth'].map((id) => ({ type: 'Person', id })),
  ]);
});

test('failed bulk request retains selections and payment values for retry and shows the server message', async () => {
  const view = picker();
  view.toggle('first'); view.toggle('second');
  view.field('Итого', '120');
  perform = async () => { throw { data: { error: { message: 'Никто не добавлен' } } }; };
  await view.submit().props.onPress();
  assert.equal(closed, 0);
  assert.ok(view.render().some((element) => element.props.role === 'alert' && label(element) === 'Никто не добавлен'));
  assert.equal(label(view.submit()), 'Добавить выбранных (2)');
  assert.equal(view.render().find((element) => element.props.label === 'Итого')!.props.value, '120');
  perform = async () => ({ count: 2 });
  await view.submit().props.onPress();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(closed, 1);
});

test('a participant added concurrently is removed from the active selection and outgoing payload', async () => {
  const view = picker();
  view.toggle('first'); view.toggle('second');
  view.existing(['existing', 'first']);
  assert.equal(label(view.submit()), 'Добавить выбранных (1)');
  assert.equal(view.render().some((element) => element.props.person?.id === 'first'), false);
  await view.submit().props.onPress();
  assert.deepEqual(sent[0].input.personIds, ['second']);
});

test('a request in flight blocks duplicate submission and dismissal', async () => {
  const view = picker();
  view.toggle('first');
  let finish!: () => void;
  perform = () => new Promise<void>((resolve) => { finish = resolve; });
  const pending = view.submit().props.onPress();
  await view.submit().props.onPress();
  loading = true;
  const tree = view.render();
  tree.find((element) => element.props.onOpenChange)!.props.onOpenChange(false);
  assert.equal(sent.length, 1);
  assert.equal(closed, 0);
  assert.ok(tree.find((element) => element.type === 'fieldset')!.props.disabled);
  assert.ok(view.button('Отмена').props.isDisabled);
  finish();
  await pending;
  assert.equal(closed, 1);
});

test('search loading does not show stale results; query errors can be retried without losing selection', () => {
  const view = picker();
  view.toggle('first');
  view.field('Поиск человека', 'Новый поиск');
  fetching = true;
  assert.equal(view.render().filter((element) => element.props.type === 'checkbox').length, 0);
  assert.ok(view.render().some((element) => element.props.role === 'status' && label(element) === 'Загрузка…'));
  fetching = false; queryError = true; pageItems = [];
  assert.ok(view.render().some((element) => element.props.role === 'alert'));
  view.button('Повторить').props.onPress();
  assert.equal(refetches, 1);
  assert.equal(label(view.submit()), 'Добавить выбранных (1)');
});

test('an all-existing page remains navigable and a reopened picker starts empty', () => {
  const view = picker();
  pageItems = [person('existing')];
  assert.ok(view.render().some((element) => label(element).includes('На этой странице все уже участвуют')));
  assert.equal(view.button('Далее').props.isDisabled, false);
  assert.equal(view.button('Назад').props.isDisabled, true);
  pageItems = [person('first')]; view.toggle('first');
  view.button('Отмена').props.onPress();
  assert.equal(closed, 1);
  assert.equal(label(picker().submit()), 'Добавить выбранных (0)');
});

test('the picker caps selection at 200 and allows replacing a selected person at the limit', async () => {
  const view = picker();
  pageItems = Array.from({ length: 201 }, (_, i) => person(`person-${i}`));
  for (let i = 0; i < 200; i++) view.toggle(`person-${i}`);
  const extra = () => view.render().find((element) => element.props['aria-label'] === 'Выбрать: person-200 Иван')!;
  assert.equal(label(view.submit()), 'Добавить выбранных (200)');
  assert.equal(extra().props.disabled, true);
  view.toggle('person-200');
  assert.equal(label(view.submit()), 'Добавить выбранных (200)');
  view.toggle('person-0');
  assert.equal(extra().props.disabled, false);
  view.toggle('person-200');
  await view.submit().props.onPress();
  assert.equal(sent[0].input.personIds.length, 200);
  assert.equal(sent[0].input.personIds.includes('person-0'), false);
  assert.equal(sent[0].input.personIds.includes('person-200'), true);
});
