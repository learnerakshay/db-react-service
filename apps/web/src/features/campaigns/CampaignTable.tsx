import {
  CAMPAIGN_STATUSES,
  type CampaignRow,
  type CampaignStatus,
  type Page,
} from '@cadentor/shared';
import { useCallback, useState } from 'react';
import { Pager, Panel, ResourceView, StatusBadge } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { apiGet } from '../../lib/api';
import { formatCount, formatTime, humanize } from '../../lib/format';
import { CampaignActions } from './CampaignActions';

const PAGE_SIZE = 25;
const REFRESH_MS = 30_000;

const numeric = 'px-3 py-2 text-right tabular-nums';

export function CampaignTable() {
  const [status, setStatus] = useState<CampaignStatus | ''>('');
  const [page, setPage] = useState(1);

  const load = useCallback(
    (signal: AbortSignal) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status !== '') params.set('status', status);
      return apiGet<Page<CampaignRow>>(`/api/v1/dashboard/campaigns?${params.toString()}`, {
        signal,
      });
    },
    [page, status],
  );
  const campaigns = useResource(load, REFRESH_MS);

  return (
    <Panel
      title="Campaigns"
      actions={
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Status
          <select
            value={status}
            onChange={(event) => {
              setStatus(CAMPAIGN_STATUSES.find((s) => s === event.target.value) ?? '');
              setPage(1);
            }}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
          >
            <option value="">All</option>
            {CAMPAIGN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <ResourceView
        resource={campaigns}
        isEmpty={(data) => data.total === 0}
        empty={status === '' ? 'No campaigns yet.' : `No ${humanize(status)} campaigns.`}
      >
        {(data) => (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1200px] text-left text-xs">
                <thead className="border-b border-zinc-800 text-[11px] text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Campaign</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className={numeric} title="All memberships">
                      Enrolled
                    </th>
                    <th className={numeric}>Queued</th>
                    <th className={numeric} title="Step 1 accepted by provider">
                      Step 1 sent
                    </th>
                    <th className={numeric} title="Leads with a matched inbound reply">
                      Replies
                    </th>
                    <th className={numeric} title="Currently engaged">
                      Engaged
                    </th>
                    <th className={numeric}>Qualified</th>
                    <th className={numeric} title="Verified bookings">
                      Booked
                    </th>
                    <th className={numeric}>Archived</th>
                    <th className={numeric}>Opt-outs</th>
                    <th className={numeric} title="Admissions in the rolling hour / limit">
                      Hourly
                    </th>
                    <th className="px-3 py-2 font-medium">Send window</th>
                    <th className="px-3 py-2 font-medium">Last activity</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {data.items.map((row) => (
                    <tr key={row.id} className="hover:bg-zinc-800/30">
                      <td className="px-3 py-2">
                        <a
                          href={`#/campaigns/${row.id}`}
                          className="font-medium text-zinc-100 hover:underline"
                        >
                          {row.name}
                        </a>
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className={numeric}>{formatCount(row.enrolled)}</td>
                      <td className={numeric}>{formatCount(row.members.QUEUED)}</td>
                      <td className={numeric}>{formatCount(row.step1Sent)}</td>
                      <td className={numeric}>{formatCount(row.repliedLeads)}</td>
                      <td className={numeric}>{formatCount(row.members.ENGAGED)}</td>
                      <td className={`${numeric} text-emerald-300`}>
                        {formatCount(row.qualified)}
                      </td>
                      <td className={`${numeric} text-emerald-300`}>{formatCount(row.booked)}</td>
                      <td className={`${numeric} text-zinc-400`}>
                        {formatCount(row.members.DORMANT_ARCHIVED)}
                      </td>
                      <td
                        className={`${numeric} ${row.members.OPTED_OUT > 0 ? 'text-rose-300' : ''}`}
                      >
                        {formatCount(row.members.OPTED_OUT)}
                      </td>
                      <td className={numeric}>
                        {row.admittedLastHour}/{row.hourlyLimit}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-zinc-300">
                        {row.sendWindow.start}–{row.sendWindow.end}
                        <span className="block text-[11px] text-zinc-500">
                          {row.timezone ?? 'Lead timezone only'}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-zinc-400">
                        {formatTime(row.lastActivityAt)}
                      </td>
                      <td className="px-3 py-2">
                        <CampaignActions campaign={row} onChanged={campaigns.reload} />
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
