import { PERSON_FIELDS, type PersonFieldKey } from '@/lib/person-fields';
import type { ReportContext, ReportFormat, ReportOrientation } from './model';

export type { ReportContext, ReportFormat, ReportOrientation } from './model';

export interface ExportPreferences {
  fields: PersonFieldKey[];
  format: ReportFormat;
  orientation: ReportOrientation;
}

const DEFAULT_FIELDS = ['lastName', 'firstName', 'middleName', 'birthDate', 'phone', 'passportNumber'];
const fieldKeys = new Set<string>(PERSON_FIELDS.map((field) => field.key));

function knownFields(value: unknown): PersonFieldKey[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is PersonFieldKey => typeof key === 'string' && fieldKeys.has(key)))];
}

export function defaultExportPreferences(): ExportPreferences {
  return { fields: knownFields(DEFAULT_FIELDS), format: 'pdf', orientation: 'portrait' };
}

export function normalizeExportPreferences(value: unknown): ExportPreferences {
  const defaults = defaultExportPreferences();
  if (!value || typeof value !== 'object') return defaults;
  const candidate = value as Record<string, unknown>;
  const fields = knownFields(candidate.fields);
  return {
    fields: fields.length ? fields : defaults.fields,
    format: candidate.format === 'xlsx' ? 'xlsx' : 'pdf',
    orientation: candidate.orientation === 'landscape' ? 'landscape' : 'portrait',
  };
}

// The parent can supply a user/database scope once those identities are available.
export function exportPreferenceKey(context: ReportContext, preferenceScope = 'local'): string {
  return `report-export:v1:${encodeURIComponent(preferenceScope)}:${context}`;
}

export function loadExportPreferences(context: ReportContext, preferenceScope = 'local'): ExportPreferences {
  try {
    if (typeof window === 'undefined') return defaultExportPreferences();
    const saved = window.localStorage.getItem(exportPreferenceKey(context, preferenceScope));
    return saved ? normalizeExportPreferences(JSON.parse(saved)) : defaultExportPreferences();
  } catch {
    return defaultExportPreferences();
  }
}

export function saveExportPreferences(
  context: ReportContext,
  preferences: ExportPreferences,
  preferenceScope = 'local',
): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(exportPreferenceKey(context, preferenceScope), JSON.stringify(preferences));
  } catch {
    // Unavailable browser storage must not interrupt a successful download.
  }
}
