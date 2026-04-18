import { api } from './api';

export type Gender = 'MALE' | 'FEMALE' | 'OTHER';

export interface Person {
  id: string;
  lastName: string;
  firstName: string;
  middleName: string | null;
  phone: string | null;
  gender: Gender | null;
  birthPlace: string | null;
  registrationAddress: string | null;
  passportNumber: string | null;
  passportIssuedBy: string | null;
  passportIssuedAt: string | null;
  passportExpiresAt: string | null;
  passportDepartmentCode: string | null;
  passportDetails: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PersonListItem extends Person {
  _count: { scans: number; participations: number };
}

export interface PassportScan {
  id: string;
  personId: string;
  filename: string;
  storedPath: string;
  thumbPath: string | null;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface ParticipationWithEvent {
  id: string;
  personId: string;
  eventId: string;
  paymentStatus: 'UNPAID' | 'PREPAID' | 'PAID';
  prepaidAmount: string | null;
  totalDue: string | null;
  notes: string | null;
  createdAt: string;
  event: {
    id: string;
    title: string;
    startDate: string;
    endDate: string;
    location: string;
    currency: 'RUB' | 'USD';
    deletedAt: string | null;
  };
}

export interface PersonDetail extends Person {
  scans: PassportScan[];
  participations: ParticipationWithEvent[];
}

export interface PersonListResponse {
  items: PersonListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PersonInput {
  lastName: string;
  firstName: string;
  middleName?: string;
  phone?: string;
  gender?: Gender;
  birthPlace?: string;
  registrationAddress?: string;
  passportNumber?: string;
  passportIssuedBy?: string;
  passportIssuedAt?: string;
  passportExpiresAt?: string;
  passportDepartmentCode?: string;
  passportDetails?: string;
  notes?: string;
}

export const peopleApi = api.injectEndpoints({
  endpoints: (b) => ({
    listPeople: b.query<PersonListResponse, { q?: string; page?: number; pageSize?: number; archived?: boolean }>({
      query: ({ q = '', page = 1, pageSize = 50, archived = false }) => {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        params.set('page', String(page));
        params.set('pageSize', String(pageSize));
        if (archived) params.set('archived', 'true');
        return { url: `people?${params}` };
      },
      providesTags: (res) =>
        res
          ? [
              ...res.items.map((p) => ({ type: 'People' as const, id: p.id })),
              { type: 'People' as const, id: 'LIST' },
            ]
          : [{ type: 'People' as const, id: 'LIST' }],
    }),
    getPerson: b.query<PersonDetail, string>({
      query: (id) => `people/${id}`,
      providesTags: (_res, _err, id) => [{ type: 'Person', id }],
    }),
    createPerson: b.mutation<Person, PersonInput>({
      query: (body) => ({ url: 'people', method: 'POST', body }),
      invalidatesTags: [{ type: 'People', id: 'LIST' }],
    }),
    updatePerson: b.mutation<Person, { id: string; data: Partial<PersonInput> }>({
      query: ({ id, data }) => ({ url: `people/${id}`, method: 'PATCH', body: data }),
      invalidatesTags: (_r, _e, a) => [
        { type: 'Person', id: a.id },
        { type: 'People', id: 'LIST' },
      ],
    }),
    deletePerson: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `people/${id}`, method: 'DELETE' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Person', id },
        { type: 'People', id: 'LIST' },
      ],
    }),
    restorePerson: b.mutation<Person, string>({
      query: (id) => ({ url: `people/${id}/restore`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Person', id },
        { type: 'People', id: 'LIST' },
      ],
    }),
  }),
});

export const {
  useListPeopleQuery,
  useGetPersonQuery,
  useCreatePersonMutation,
  useUpdatePersonMutation,
  useDeletePersonMutation,
  useRestorePersonMutation,
} = peopleApi;
