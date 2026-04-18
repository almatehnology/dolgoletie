import { api } from './api';
import type { Event } from './events-api';
import type { Person } from './people-api';

export const searchApi = api.injectEndpoints({
  endpoints: (b) => ({
    search: b.query<{ people: Person[]; events: Event[] }, { q: string; scope?: 'all' | 'people' | 'events' }>({
      query: ({ q, scope = 'all' }) => {
        const params = new URLSearchParams({ q, scope });
        return { url: `search?${params}` };
      },
      providesTags: [{ type: 'Search', id: 'GLOBAL' }],
    }),
  }),
});

export const { useSearchQuery, useLazySearchQuery } = searchApi;
