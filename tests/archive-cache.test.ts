import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeStore } from '../lib/store';
import { api } from '../lib/store/api';
import { archiveApi } from '../lib/store/archive-api';
import { peopleApi } from '../lib/store/people-api';
import { eventsApi } from '../lib/store/events-api';
import { searchApi } from '../lib/store/search-api';

for (const action of ['restore', 'delete'] as const) {
  test(`${action} invalidates active/archive lists, both detail types, relations, scans and search`, async (t) => {
    const NativeRequest = globalThis.Request;
    globalThis.Request = class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' && input.startsWith('/') ? new URL(input, 'http://localhost') : input, init);
      }
    };
    t.after(() => { globalThis.Request = NativeRequest; });
    t.mock.method(globalThis, 'fetch', async (request: Request) => {
      assert.equal(request.url, 'http://localhost/api/archive');
      assert.equal(request.method, 'POST');
      const body = await request.json();
      assert.deepEqual(body, { entity: 'people', action, ids: ['person'], confirm: true });
      return Response.json({ ...body, count: 1 });
    });
    const store = makeStore();
    t.after(() => { store.dispatch(api.util.resetApiState()); });
    for (const archived of [true, false]) {
      await store.dispatch(peopleApi.util.upsertQueryData('listPeople', { archived }, { items: [], total: 0, page: 1, pageSize: 50 }));
      await store.dispatch(eventsApi.util.upsertQueryData('listEvents', { archived }, { items: [], total: 0, page: 1, pageSize: 50 }));
    }
    await store.dispatch(peopleApi.util.upsertQueryData('getPerson', 'person', { id: 'person', scans: [], participations: [] } as any));
    await store.dispatch(eventsApi.util.upsertQueryData('getEvent', 'event', { id: 'event', excursions: [], participations: [] } as any));
    await store.dispatch(searchApi.util.upsertQueryData('search', { q: 'search' }, { people: [], events: [] }));
    const relations = api.injectEndpoints({ endpoints: (b) => ({ archiveTestRelations: b.query<null, void>({ queryFn: async () => ({ data: null }), providesTags: ['Participations', 'Scans'] }) }) });
    await store.dispatch(relations.util.upsertQueryData('archiveTestRelations', undefined, null));
    assert.equal(Object.keys(store.getState().api.queries).length, 8);
    const operation = store.dispatch(archiveApi.endpoints.applyArchiveAction.initiate({ entity: 'people', action, ids: ['person'], confirm: true }));
    assert.equal((await operation.unwrap()).count, 1);
    assert.equal(Object.keys(store.getState().api.queries).length, 0);
    operation.reset();
  });
}
