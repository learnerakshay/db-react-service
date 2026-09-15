import type {
  IntegrationHealth,
  IntegrationHealthResponse,
  IntegrationKey,
} from '@cadentor/shared';
import { Panel, ResourceView, StatusBadge } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { apiGet } from '../../lib/api';
import { formatTime, humanize } from '../../lib/format';
import { conversationHref } from '../../lib/route';

const REFRESH_MS = 60_000;

const LABELS: Readonly<Record<IntegrationKey, string>> = {
  CRM: 'CRM sync',
  OWNER_NOTIFICATION: 'Owner notifications',
  POST_BOOKING_HANDOFF: 'Post-booking handoff',
  CALENDAR: 'Calendar',
};

const COUNT_TONE: Readonly<Record<string, string>> = {
  COMPLETED: 'text-emerald-300',
  PROCESSED: 'text-emerald-300',
  FAILED: 'text-rose-300',
  RETRY: 'text-amber-300',
  BLOCKED: 'text-amber-300',
  PENDING: 'text-zinc-200',
};

const loadHealth = (signal: AbortSignal) =>
  apiGet<IntegrationHealthResponse>('/api/v1/integrations/health', { signal });

export function IntegrationHealthPanel() {
  const health = useResource(loadHealth, REFRESH_MS);
  return (
    <Panel title="Integration health">
      <ResourceView resource={health}>
        {(data) => (
          <>
            <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
              {data.integrations.map((integration) => (
                <IntegrationCard key={integration.key} integration={integration} />
              ))}
            </div>
            <div className="border-t border-zinc-800">
              <h3 className="px-4 pt-3 text-xs font-medium text-zinc-400">
                Failing and blocked deliveries
              </h3>
              {data.problems.length === 0 ? (
                <p className="px-4 py-4 text-sm text-zinc-500">No failing or blocked deliveries.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-xs">
                    <thead className="text-[11px] text-zinc-500">
                      <tr>
                        <th className="px-4 py-2 font-medium">Updated</th>
                        <th className="px-4 py-2 font-medium">Lead</th>
                        <th className="px-4 py-2 font-medium">Destination</th>
                        <th className="px-4 py-2 font-medium">Event</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 text-right font-medium">Attempts</th>
                        <th className="px-4 py-2 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/70">
                      {data.problems.map((problem) => (
                        <tr key={problem.id}>
                          <td className="px-4 py-2 whitespace-nowrap text-zinc-400">
                            {formatTime(problem.updatedAt)}
                          </td>
                          <td className="px-4 py-2">
                            <a href={conversationHref(problem.leadId)} className="hover:underline">
                              {problem.leadName}
                            </a>
                          </td>
                          <td className="px-4 py-2">{LABELS[problem.destination]}</td>
                          <td className="px-4 py-2 text-zinc-400">{humanize(problem.eventType)}</td>
                          <td className="px-4 py-2">
                            <StatusBadge status={problem.status} />
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{problem.attempts}</td>
                          <td className="px-4 py-2 font-mono text-[11px] text-zinc-400">
                            {problem.lastErrorCode ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </ResourceView>
    </Panel>
  );
}

function summary(integration: IntegrationHealth): string {
  const n = (key: string) => integration.counts[key] ?? 0;
  if (integration.key === 'CALENDAR') {
    const events = Object.values(integration.counts).reduce((sum, value) => sum + value, 0);
    return integration.configured
      ? `${events} verified booking webhook events`
      : 'Provider not configured — booking confirmations cannot arrive';
  }
  if (!integration.configured) {
    return `Provider not configured — ${n('BLOCKED')} blocked (not sent)`;
  }
  if (integration.state === 'FAILING') {
    return `Configured but failing — ${n('FAILED')} failed, ${n('RETRY')} retrying`;
  }
  return integration.state === 'IDLE'
    ? 'Configured — no deliveries yet'
    : `Configured — ${n('COMPLETED')} completed`;
}

function IntegrationCard({ integration }: { integration: IntegrationHealth }) {
  const counts = Object.entries(integration.counts);
  return (
    <article
      aria-label={LABELS[integration.key]}
      className="rounded-md border border-zinc-800 bg-zinc-950 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-100">{LABELS[integration.key]}</h3>
        <StatusBadge status={integration.state} />
      </div>
      <p className="mt-1 text-xs text-zinc-400">{summary(integration)}</p>
      {counts.length > 0 && (
        <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {counts.map(([key, value]) => (
            <div key={key} className="flex gap-1">
              <dt className="text-zinc-500">{humanize(key)}</dt>
              <dd
                className={`tabular-nums ${value > 0 ? (COUNT_TONE[key] ?? 'text-zinc-200') : 'text-zinc-600'}`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
