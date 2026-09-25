/**
 * Versioned, picture-free export and validated import of local data
 * (blueprint §13). Pure functions — storage.js applies the plan.
 */
import { ValidationError, validateCorrection, validateGroupingSettings, validateProfile } from './schema.js';

export const EXPORT_FORMAT = 'laundry-color-scanner-export';
export const EXPORT_SCHEMA_VERSION = 1;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_RECORDS = 5000;

export function buildExport({ corrections, profiles, settings, appVersion, now = Date.now() }) {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
    appVersion,
    corrections,
    profiles,
    settings: { grouping: settings.grouping ?? null },
  };
}

export class ImportError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

/**
 * Parse and validate an export file's text. Every record is validated on its
 * own; invalid ones are counted and skipped, existing IDs are skipped.
 * Returns a plan: { corrections, profiles, settings, counts }.
 */
export function planImport(text, { existingCorrectionIds = new Set(), existingProfileIds = new Set(), byteLength } = {}) {
  const size = byteLength ?? new TextEncoder().encode(text).length;
  if (size > MAX_IMPORT_BYTES) throw new ImportError('too-large', 'The file is larger than 5 MB.');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError('not-json', 'The file is not valid JSON.');
  }
  if (!data || data.format !== EXPORT_FORMAT) throw new ImportError('wrong-format', 'This is not a Laundry Color Scanner export.');
  if (data.schemaVersion !== EXPORT_SCHEMA_VERSION) throw new ImportError('unsupported-version', `Unsupported export version ${data.schemaVersion}.`);
  const corrections = Array.isArray(data.corrections) ? data.corrections : [];
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  if (corrections.length + profiles.length > MAX_IMPORT_RECORDS) {
    throw new ImportError('too-many-records', `The file has more than ${MAX_IMPORT_RECORDS} records.`);
  }
  const counts = { corrections: { add: 0, duplicate: 0, invalid: 0 }, profiles: { add: 0, duplicate: 0, invalid: 0 } };
  const pick = (records, validate, existing, bucket) => {
    const seen = new Set();
    const out = [];
    for (const record of records) {
      try {
        validate(migrateRecord(record));
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        bucket.invalid++;
        continue;
      }
      if (existing.has(record.id) || seen.has(record.id)) {
        bucket.duplicate++;
        continue;
      }
      seen.add(record.id);
      out.push(record);
      bucket.add++;
    }
    return out;
  };
  const plan = {
    corrections: pick(corrections, validateCorrection, existingCorrectionIds, counts.corrections),
    profiles: pick(profiles, validateProfile, existingProfileIds, counts.profiles),
    settings: null,
    counts,
  };
  if (data.settings?.grouping) {
    try {
      plan.settings = { grouping: validateGroupingSettings(data.settings.grouping) };
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
    }
  }
  return plan;
}

/**
 * Record migrations by schemaVersion. Version 1 is current; unknown versions
 * pass through unchanged and are then rejected by validation.
 */
export function migrateRecord(record) {
  return record;
}
