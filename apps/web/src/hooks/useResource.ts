import { useCallback, useEffect, useState } from 'react';

export type Loader<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Loading/error convention for every async view.
 * - `data` is the last successful result for the current loader (kept while
 *   refreshing, and after a failed refresh so partial data stays visible).
 * - `error` is the latest failure for the current loader, cleared on success.
 */
export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

interface Result<T> {
  load: Loader<T>;
  tick: number;
  data: T | undefined;
  error: Error | undefined;
}

/**
 * Runs `load` on mount, whenever `load` changes, on `reload()`, and every
 * `refreshMs` while the page is visible. In-flight requests are aborted when
 * superseded or unmounted. `load` must be stable (module-level or useCallback).
 */
export function useResource<T>(load: Loader<T>, refreshMs?: number): Resource<T> {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<Result<T> | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        setResult({ load, tick, data, error: undefined });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          load,
          tick,
          data: previous?.load === load ? previous.data : undefined,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      },
    );
    return () => {
      controller.abort();
    };
  }, [load, tick]);

  useEffect(() => {
    if (refreshMs === undefined) return;
    const timer = setInterval(() => {
      if (!document.hidden) setTick((value) => value + 1);
    }, refreshMs);
    return () => {
      clearInterval(timer);
    };
  }, [refreshMs]);

  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  const current = result?.load === load ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: current?.tick !== tick,
    reload,
  };
}
