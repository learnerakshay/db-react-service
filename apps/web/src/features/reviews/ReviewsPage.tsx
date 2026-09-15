import {
  ESCALATION_REASONS,
  type EscalationReason,
  type Page,
  type ReviewItem,
} from '@cadentor/shared';
import { useCallback, useState } from 'react';
import { Pager, Panel, ResourceView, StatusBadge } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { apiGet } from '../../lib/api';
import { formatTime, humanize } from '../../lib/format';
import { conversationHref } from '../../lib/route';

const PAGE_SIZE = 25;
const REFRESH_MS = 20_000;

export function ReviewsPage() {
  const [reason, setReason] = useState<EscalationReason | ''>('');
  const [page, setPage] = useState(1);

  const load = useCallback(
    (signal: AbortSignal) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (reason !== '') params.set('reason', reason);
      return apiGet<Page<ReviewItem>>(`/api/v1/reviews?${params.toString()}`, { signal });
    },
    [page, reason],
  );
  const reviews = useResource(load, REFRESH_MS);

  return (
    <Panel
      title="Human review queue"
      actions={
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Reason
          <select
            value={reason}
            onChange={(event) => {
              setReason(ESCALATION_REASONS.find((r) => r === event.target.value) ?? '');
              setPage(1);
            }}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
          >
            <option value="">All reasons</option>
            {ESCALATION_REASONS.map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <p className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500">
        Unresolved escalations, newest first. Opening an item does not resolve it.
      </p>
      <ResourceView
        resource={reviews}
        isEmpty={(data) => data.total === 0}
        empty="No conversations are waiting for human review."
      >
        {(data) => (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] text-left text-xs">
                <thead className="border-b border-zinc-800 text-[11px] text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Escalated</th>
                    <th className="px-3 py-2 font-medium">Lead</th>
                    <th className="px-3 py-2 font-medium">Campaign</th>
                    <th className="px-3 py-2 font-medium">Latest inbound</th>
                    <th className="px-3 py-2 font-medium">Reason</th>
                    <th className="px-3 py-2 font-medium">Classification</th>
                    <th className="px-3 py-2 text-right font-medium">Confidence</th>
                    <th className="px-3 py-2 font-medium">Membership</th>
                    <th className="px-3 py-2 font-medium">Automation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {data.items.map((item) => (
                    <tr key={item.processingId} className="align-top hover:bg-zinc-800/30">
                      <td className="px-3 py-2 whitespace-nowrap text-zinc-400">
                        {formatTime(item.createdAt)}
                      </td>
                      <td className="px-3 py-2">
                        {item.leadId === null ? (
                          <span className="text-zinc-300">{item.leadName}</span>
                        ) : (
                          <a
                            href={conversationHref(item.leadId)}
                            className="font-medium text-zinc-100 hover:underline"
                          >
                            {item.leadName}
                          </a>
                        )}
                      </td>
                      <td className="px-3 py-2 text-zinc-300">{item.campaign?.name ?? '—'}</td>
                      <td className="max-w-xs px-3 py-2">
                        <p className="line-clamp-2 text-zinc-200">{item.inbound.body ?? '—'}</p>
                        <span className="text-[11px] text-zinc-500">
                          {formatTime(item.inbound.at)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {item.escalationReason === null ? (
                          '—'
                        ) : (
                          <StatusBadge status={item.escalationReason} tone="amber" />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {item.classification === null ? (
                          '—'
                        ) : (
                          <StatusBadge status={item.classification} />
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {item.confidence === null ? '—' : `${Math.round(item.confidence * 100)}%`}
                      </td>
                      <td className="px-3 py-2">
                        {item.membershipStatus === null ? (
                          '—'
                        ) : (
                          <StatusBadge status={item.membershipStatus} />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {item.automation === null ? (
                          '—'
                        ) : (
                          <StatusBadge status={item.automation.mode} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </ResourceView>
    </Panel>
  );
}
