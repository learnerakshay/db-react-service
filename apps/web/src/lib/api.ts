import { isApiErrorBody, type ErrorCode } from '@cadentor/shared';
import { clearToken, getToken, UNAUTHORIZED_EVENT } from './auth';
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
export function apiGet<T>(path: string, { signal }: RequestOptions = {}): Promise<T> {
  return request<T>(path, 'GET', undefined, signal);
}

/** Operator controls. The server validates every state change; the UI never assumes one. */
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, 'POST', body, undefined);
}

async function request<T>(
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiClientError(0, 'NETWORK_ERROR', 'Unable to reach the API');
  }

  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiClientError(
      response.status,
      'INVALID_RESPONSE',
      'API returned a non-JSON response',
    );
  }

  if (!response.ok) {
    if (isApiErrorBody(parsed)) {
      throw new ApiClientError(
        response.status,
        parsed.error.code,
        parsed.error.message,
        parsed.error.requestId,
      );
    }
    throw new ApiClientError(
      response.status,
      'INVALID_RESPONSE',
      `API request failed (${response.status})`,
    );
  }

  return parsed as T;
}

/** Operator-facing wording for failures; keeps the server's safe message otherwise. */
export function describeError(error: Error): string {
  if (!(error instanceof ApiClientError)) return error.message;
  if (error.status === 503) {
    return 'Service unavailable: the database cannot be reached. Retrying automatically.';
  }
  if (error.code === 'NETWORK_ERROR') return 'Cannot reach the API. Check the connection.';
  if (error.status === 403) return `Not permitted: ${error.message}`;
  return error.message;
}
