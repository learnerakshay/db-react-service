/** Stable machine-readable error codes returned by the API. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'PROVIDER_ERROR',
  'CONFIGURATION_ERROR',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorIssue {
  path: string;
  message: string;
}

/** Shape of every non-2xx JSON response body. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    issues?: ApiErrorIssue[];
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof error.message === 'string' &&
    (ERROR_CODES as readonly unknown[]).includes(error.code)
  );
}
