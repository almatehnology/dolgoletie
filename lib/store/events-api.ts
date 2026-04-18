import { api } from './api';

export type Currency = 'RUB' | 'USD';
export type TransportType = 'BUS' | 'TRAIN' | 'PLANE' | 'OTHER';
export type PaymentStatus = 'UNPAID' | 'PREPAID' | 'PAID';

export interface ExcursionInput {
  id?: string;
  name: string;
  cost?: string | null;
}

export interface Event {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  location: string;
  cost: string | null;
  currency: Currency;
  program: string | null;
  isOutbound: boolean;
  accommodationPlace: string | null;
  accommodationOrder: string | null;
  mealType: string | null;
  staysFrom: string | null;
  staysTo: string | null;
  accommodationCost: string | null;
  transportType: TransportType | null;
  transportInfo: string | null;
  transportCost: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface EventListItem extends Event {
  _count: { participations: number; excursions: number };
}

export interface EventListResponse {
  items: EventListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Excursion {
  id: string;
  eventId: string;
  name: string;
  cost: string | null;
}

export interface ParticipationWithPerson {
  id: string;
  personId: string;
  eventId: string;
  paymentStatus: PaymentStatus;
  prepaidAmount: string | null;
  totalDue: string | null;
  notes: string | null;
  createdAt: string;
  person: {
    id: string;
    lastName: string;
    firstName: string;
    middleName: string | null;
    phone: string | null;
    passportNumber: string | null;
    deletedAt: string | null;
  };
}

export interface EventDetail extends Event {
  excursions: Excursion[];
  participations: ParticipationWithPerson[];
}

export interface EventInput {
  title: string;
  startDate: string;
  endDate: string;
  location: string;
  cost?: string;
  currency: Currency;
  program?: string;
  isOutbound: boolean;
  accommodationPlace?: string;
  accommodationOrder?: string;
  mealType?: string;
  staysFrom?: string;
  staysTo?: string;
  accommodationCost?: string;
  transportType?: TransportType;
  transportInfo?: string;
  transportCost?: string;
  excursions: ExcursionInput[];
}

export interface ParticipationInput {
  personId: string;
  paymentStatus: PaymentStatus;
  prepaidAmount?: string;
  totalDue?: string;
  notes?: string;
}

export const eventsApi = api.injectEndpoints({
  endpoints: (b) => ({
    listEvents: b.query<EventListResponse, { q?: string; from?: string; to?: string; page?: number; pageSize?: number; archived?: boolean }>({
      query: ({ q = '', from, to, page = 1, pageSize = 50, archived = false }) => {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        params.set('page', String(page));
        params.set('pageSize', String(pageSize));
        if (archived) params.set('archived', 'true');
        return { url: `events?${params}` };
      },
      providesTags: (res) =>
        res
          ? [
              ...res.items.map((e) => ({ type: 'Events' as const, id: e.id })),
              { type: 'Events' as const, id: 'LIST' },
            ]
          : [{ type: 'Events' as const, id: 'LIST' }],
    }),
    getEvent: b.query<EventDetail, string>({
      query: (id) => `events/${id}`,
      providesTags: (_r, _e, id) => [{ type: 'Event', id }],
    }),
    createEvent: b.mutation<Event, EventInput>({
      query: (body) => ({ url: 'events', method: 'POST', body }),
      invalidatesTags: [{ type: 'Events', id: 'LIST' }],
    }),
    updateEvent: b.mutation<Event, { id: string; data: Partial<EventInput> }>({
      query: ({ id, data }) => ({ url: `events/${id}`, method: 'PATCH', body: data }),
      invalidatesTags: (_r, _e, a) => [
        { type: 'Event', id: a.id },
        { type: 'Events', id: 'LIST' },
      ],
    }),
    deleteEvent: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `events/${id}`, method: 'DELETE' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Event', id },
        { type: 'Events', id: 'LIST' },
      ],
    }),
    restoreEvent: b.mutation<Event, string>({
      query: (id) => ({ url: `events/${id}/restore`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Event', id },
        { type: 'Events', id: 'LIST' },
      ],
    }),
    addParticipant: b.mutation<ParticipationWithPerson, { eventId: string; input: ParticipationInput }>({
      query: ({ eventId, input }) => ({ url: `events/${eventId}/participants`, method: 'POST', body: input }),
      invalidatesTags: (_r, _e, a) => [
        { type: 'Event', id: a.eventId },
        { type: 'Person', id: a.input.personId },
      ],
    }),
    updateParticipation: b.mutation<
      ParticipationWithPerson,
      { id: string; eventId: string; personId: string; data: Partial<ParticipationInput> }
    >({
      query: ({ id, data }) => ({ url: `participations/${id}`, method: 'PATCH', body: data }),
      invalidatesTags: (_r, _e, a) => [
        { type: 'Event', id: a.eventId },
        { type: 'Person', id: a.personId },
      ],
    }),
    removeParticipation: b.mutation<{ ok: true }, { id: string; eventId: string; personId: string }>({
      query: ({ id }) => ({ url: `participations/${id}`, method: 'DELETE' }),
      invalidatesTags: (_r, _e, a) => [
        { type: 'Event', id: a.eventId },
        { type: 'Person', id: a.personId },
      ],
    }),
  }),
});

export const {
  useListEventsQuery,
  useGetEventQuery,
  useCreateEventMutation,
  useUpdateEventMutation,
  useDeleteEventMutation,
  useRestoreEventMutation,
  useAddParticipantMutation,
  useUpdateParticipationMutation,
  useRemoveParticipationMutation,
} = eventsApi;
