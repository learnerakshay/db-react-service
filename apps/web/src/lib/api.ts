import { isApiErrorBody, type ErrorCode } from '@cadentor/shared';
import { config } from './config';

export type ApiClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';

/** Every failed API call rejects with this, so UI code handles one error type. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiClientErrorCode;
  readonly requestId: string | undefined;

  constructor(status: number, code: ApiClientErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * The only place the web app calls `fetch` against the API.
 * Response bodies are typed by the shared contracts in @cadentor/shared.
 */
export async function apiGet<T>(path: string, { signal }: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiClientError(0, 'NETWORK_ERROR', 'Unable to reach the API');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiClientError(
      response.status,
      'INVALID_RESPONSE',
      'API returned a non-JSON response',
    );
  }

  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(
        response.status,
        body.error.code,
        body.error.message,
        body.error.requestId,
      );
    }
    throw new ApiClientError(
      response.status,
      'INVALID_RESPONSE',
      `API request failed (${response.status})`,
    );
  }

  return body as T;
}
