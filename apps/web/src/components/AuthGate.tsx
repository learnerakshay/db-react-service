import type { OperatorIdentity } from '@cadentor/shared';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { ApiClientError, apiGet, describeError } from '../lib/api';
import { clearToken, getToken, setToken, UNAUTHORIZED_EVENT } from '../lib/auth';
import { OperatorSessionContext } from '../lib/operator';
import { ErrorNotice, LoadingIndicator } from './Feedback';

type GateState =
  | { kind: 'signed-out'; message: string | null }
  | { kind: 'checking' }
  | { kind: 'ready'; operator: OperatorIdentity }
  | { kind: 'unavailable'; message: string };

/**
 * Operator sign-in boundary. Nothing below renders or calls data endpoints
 * until GET /auth/me accepts the stored token. Any later 401 signs out.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>(() =>
    getToken() === null ? { kind: 'signed-out', message: null } : { kind: 'checking' },
  );

  // Verification runs whenever the gate enters `checking` (mount with a stored
  // token, sign-in, retry); state is only set from the async result.
  useEffect(() => {
    if (state.kind !== 'checking') return;
    let active = true;
    void verifyStoredToken().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, [state.kind]);

  useEffect(() => {
    const onUnauthorized = () => {
      setState({ kind: 'signed-out', message: 'Your session ended. Sign in again.' });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setState({ kind: 'signed-out', message: null });
  }, []);

  const session = useMemo(
    () => (state.kind === 'ready' ? { operator: state.operator, signOut } : null),
    [state, signOut],
  );

  if (state.kind === 'ready' && session !== null) {
    return (
      <OperatorSessionContext.Provider value={session}>{children}</OperatorSessionContext.Provider>
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <div className="mb-4 flex items-baseline gap-2">
          <span className="text-sm font-semibold text-zinc-50">Cadentor</span>
          <span className="text-xs text-zinc-500">Mission Control</span>
        </div>
        {state.kind === 'checking' && <LoadingIndicator label="Verifying operator access…" />}
        {state.kind === 'unavailable' && (
          <div className="space-y-3">
            <ErrorNotice message={state.message} />
            <div className="flex gap-2">
              <button
                type="button"
                className={SECONDARY}
                onClick={() => {
                  setState({ kind: 'checking' });
                }}
              >
                Retry
              </button>
              <button type="button" className={SECONDARY} onClick={signOut}>
                Sign out
              </button>
            </div>
          </div>
        )}
        {state.kind === 'signed-out' && (
          <SignInForm
            message={state.message}
            onSubmit={(token) => {
              setToken(token);
              setState({ kind: 'checking' });
            }}
          />
        )}
      </div>
    </main>
  );
}

async function verifyStoredToken(): Promise<GateState> {
  try {
    const operator = await apiGet<OperatorIdentity>('/api/v1/auth/me');
    return { kind: 'ready', operator };
  } catch (err) {
    if (err instanceof ApiClientError && (err.status === 401 || err.status === 429)) {
      clearToken();
      return {
        kind: 'signed-out',
        message:
          err.status === 429 ? err.message : 'That token was not accepted. Check it and try again.',
      };
    }
    return {
      kind: 'unavailable',
      message: describeError(err instanceof Error ? err : new Error(String(err))),
    };
  }
}

const SECONDARY =
  'rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400';

function SignInForm({
  message,
  onSubmit,
}: {
  message: string | null;
  onSubmit: (token: string) => void;
}) {
  const [token, setTokenValue] = useState('');
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (trimmed !== '') onSubmit(trimmed);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block space-y-1 text-xs text-zinc-400">
        <span>Operator token</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => {
            setTokenValue(event.target.value);
          }}
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-amber-400"
        />
      </label>
      {message !== null && <ErrorNotice message={message} />}
      <button
        type="submit"
        disabled={token.trim() === ''}
        className="w-full rounded border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Sign in
      </button>
      <p className="text-[11px] text-zinc-500">
        Tokens are issued by an administrator. The session ends when this tab closes.
      </p>
    </form>
  );
}
