import type { AuditEventDto, Page } from '@cadentor/shared';
import { Badge, Panel, RefreshControl, ResourceView } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { apiGet } from '../../lib/api';
import { formatTime, humanize } from '../../lib/format';
import { conversationHref } from '../../lib/route';

const REFRESH_MS = 30_000;

const loadAudit = (signal: AbortSignal) =>
  apiGet<Page<AuditEventDto>>('/api/v1/audit?pageSize=15', { signal });

/** Recent manual operator actions from the append-only audit log. */
export function OperatorActivityPanel() {
  const audit = useResource(loadAudit, REFRESH_MS);
  return (
    <Panel title="Operator activity" actions={<RefreshControl resource={audit} at={null} />}>
      <ResourceView
        resource={audit}
        isEmpty={(data) => data.total === 0}
        empty="No operator actions recorded yet."
      >
        {(data) => (
          <ol className="divide-y divide-zinc-800/70">
            {data.items.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs">
                <span className="w-28 shrink-0 text-zinc-500">{formatTime(event.createdAt)}</span>
                <span className="text-zinc-200">{event.actorId}</span>
                <Badge tone="amber">{humanize(event.action)}</Badge>
                <Target event={event} />
                <span className="ml-auto truncate font-mono text-[11px] text-zinc-500">
                  {Object.entries(event.metadata)
                    .filter(([, value]) => value !== null)
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(' ')}
                </span>
              </li>
            ))}
          </ol>
        )}
      </ResourceView>
    </Panel>
  );
}

function Target({ event }: { event: AuditEventDto }) {
  if (event.targetType === 'CAMPAIGN') {
    return (
      <a href={`#/campaigns/${event.targetId}`} className="text-zinc-300 hover:underline">
        campaign
      </a>
    );
  }
  if (event.targetType === 'LEAD') {
    return (
      <a href={conversationHref(event.targetId)} className="text-zinc-300 hover:underline">
        lead
      </a>
    );
  }
  return <span className="text-zinc-400">{humanize(event.targetType).toLowerCase()}</span>;
}
