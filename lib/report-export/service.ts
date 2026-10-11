import { buildTableReport, MAX_REPORT_PEOPLE, ReportError, type EventRecord, type PersonRecord, type ReportRequest, type TableReport } from './model';

export interface ReportRepository {
  findPeople(ids: string[]): Promise<PersonRecord[]>;
  findEvent(id: string): Promise<EventRecord | null>;
}

export async function loadTableReport(request: ReportRequest, repository: ReportRepository): Promise<TableReport> {
  if (request.context === 'people') {
    const ids = request.personIds!;
    const people = await repository.findPeople(ids);
    const byId = new Map(people.filter((person) => !person.deletedAt).map((person) => [person.id, person]));
    const unavailable = ids.filter((id) => !byId.has(id));
    if (unavailable.length) {
      throw new ReportError('PEOPLE_UNAVAILABLE', `Выбранные карточки отсутствуют или находятся в архиве: ${unavailable.length}. Обновите выбор.`, 409);
    }
    return buildTableReport(request, ids.map((id) => byId.get(id)!));
  }
  const event = await repository.findEvent(request.eventId!);
  if (!event) throw new ReportError('NOT_FOUND', 'Мероприятие не найдено.', 404);
  // Archived cards remain participants. Never silently exclude them.
  if (event.people.length > MAX_REPORT_PEOPLE) throw new ReportError('REPORT_LIMIT', `В мероприятии больше ${MAX_REPORT_PEOPLE} участников.`, 413);
  return buildTableReport(request, event.people, event);
}
