import type { HealthResponse } from '@cadentor/shared';
import { ErrorNotice, LoadingIndicator } from '../components/Feedback';
import { useAsync } from '../hooks/useAsync';
import { apiGet } from '../lib/api';

const loadHealth = (signal: AbortSignal) => apiGet<HealthResponse>('/health', { signal });

/** Phase 0 placeholder. No dashboard functionality belongs here yet. */
export function HomePage() {
  const health = useAsync(loadHealth);

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Cadentor</h1>
      <p className="text-lg text-slate-300">Dormant Lead &amp; Database Reactivation Engine</p>
      <p className="mt-4 rounded-full border border-emerald-500/40 px-4 py-1 text-sm text-emerald-400">
        System Foundation Ready
      </p>
      <div className="mt-2">
        {health.status === 'loading' && <LoadingIndicator label="Checking API…" />}
        {health.status === 'error' && (
          <ErrorNotice message={`API unavailable: ${health.error.message}`} />
        )}
        {health.status === 'success' && <p className="text-sm text-slate-400">API online</p>}
      </div>
    </main>
  );
}
