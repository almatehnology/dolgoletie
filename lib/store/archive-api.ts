import { api } from './api';
import type { ArchiveRequest, ArchiveResult } from '@/lib/archive/model';

export const archiveApi = api.injectEndpoints({
  endpoints: (b) => ({
    applyArchiveAction: b.mutation<ArchiveResult, ArchiveRequest>({
      query: (body) => ({ url: 'archive', method: 'POST', body }),
      // Parent deletion changes dependent lists/counts and embedded records in
      // both kinds of detail view. Refresh on conflicts too, to show fresh state.
      invalidatesTags: ['People', 'Person', 'Events', 'Event', 'Participations', 'Scans', 'Search'],
    }),
  }),
});

export const { useApplyArchiveActionMutation } = archiveApi;
