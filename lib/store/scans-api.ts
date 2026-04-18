import { api } from './api';
import type { PassportScan } from './people-api';

export const scansApi = api.injectEndpoints({
  endpoints: (b) => ({
    uploadScans: b.mutation<{ items: PassportScan[] }, { personId: string; files: File[] }>({
      query: ({ personId, files }) => {
        const body = new FormData();
        for (const f of files) body.append('files', f);
        return { url: `people/${personId}/scans`, method: 'POST', body };
      },
      invalidatesTags: (_r, _e, a) => [{ type: 'Person', id: a.personId }],
    }),
    deleteScan: b.mutation<{ ok: true }, { id: string; personId: string }>({
      query: ({ id }) => ({ url: `scans/${id}`, method: 'DELETE' }),
      invalidatesTags: (_r, _e, a) => [{ type: 'Person', id: a.personId }],
    }),
  }),
});

export const { useUploadScansMutation, useDeleteScanMutation } = scansApi;
