/**
 * Operator bearer token storage. Session-scoped: closing the tab signs out.
 * The token is never logged, never put in URLs, and only sent to the API.
 */
const STORAGE_KEY = 'cadentor.operatorToken';

/** Fired when any API call answers 401, so the app can return to sign-in. */
export const UNAUTHORIZED_EVENT = 'cadentor:unauthorized';

export function getToken(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked (privacy mode): behave as signed out.
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage blocked: the gate re-prompts on the next request instead.
    return;
  }
}

export function clearToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored when storage is unavailable.
    return;
  }
}
