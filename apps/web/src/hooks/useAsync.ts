import { useEffect, useState } from 'react';

/** Loading/error convention: every async view renders from this union. */
export type AsyncState<T> =
  { status: 'loading' } | { status: 'success'; data: T } | { status: 'error'; error: Error };

/**
 * Runs `load` on mount and aborts it on unmount.
 * `load` must be stable (module-level or memoized), or it re-runs every render.
 */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        setState({ status: 'success', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [load]);

  return state;
}
