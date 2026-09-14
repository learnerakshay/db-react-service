/** Canonical lead input fields every ingestion adapter maps its source into. */
export const LEAD_INPUT_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'source',
  'externalId',
  'lastServiceDate',
  'timezone',
] as const;

export type LeadInputField = (typeof LEAD_INPUT_FIELDS)[number];

export function isLeadInputField(value: string): value is LeadInputField {
  return (LEAD_INPUT_FIELDS as readonly string[]).includes(value);
}

export const IMPORT_BATCH_STATUSES = ['PROCESSING', 'COMPLETED', 'FAILED'] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const IMPORT_SOURCE_TYPES = ['CSV'] as const;
export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

export const IMPORT_ROW_OUTCOMES = [
  'CREATED',
  'EXISTING',
  'DUPLICATE',
  'SUPPRESSED',
  'INVALID',
  'FAILED',
] as const;
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number];

export const IMPORT_ROW_REASONS = [
  'MALFORMED_ROW',
  'MISSING_PHONE',
  'INVALID_PHONE',
  'PHONE_COUNTRY_REQUIRED',
  'DUPLICATE_IN_BATCH',
  'SUPPRESSED_PHONE',
  'SUPPRESSED_EMAIL',
  'PERSISTENCE_ERROR',
] as const;
export type ImportRowReason = (typeof IMPORT_ROW_REASONS)[number];

/** total = accepted + duplicates + suppressed + invalid + failed. */
export interface ImportCounts {
  total: number;
  /** Rows that resolved to an active lead (new or existing). */
  accepted: number;
  /** Subset of accepted that created a new lead. */
  newLeads: number;
  /** Repeats of a phone already seen earlier in the same import. */
  duplicates: number;
  suppressed: number;
  invalid: number;
  failed: number;
  /** Campaign memberships created (imports with a campaign only). */
  staged: number;
}

export interface ImportBatchSummary {
  id: string;
  sourceType: ImportSourceType;
  sourceReference: string | null;
  sourceLabel: string;
  status: ImportBatchStatus;
  campaignId: string | null;
  defaultCountry: string | null;
  counts: ImportCounts;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
}

/** A row that was not cleanly accepted, or was accepted with dropped fields. */
export interface ImportRowIssue {
  rowNumber: number;
  outcome: ImportRowOutcome;
  reason: ImportRowReason | null;
  ignoredFields: LeadInputField[];
}

export interface ImportBatchDetail extends ImportBatchSummary {
  issues: ImportRowIssue[];
  issuesTruncated: boolean;
}
