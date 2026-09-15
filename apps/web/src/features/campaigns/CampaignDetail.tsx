import {
  CAMPAIGN_LEAD_STATUSES,
  type ActivityKind,
  type CampaignOverviewResponse,
} from '@cadentor/shared';
import { useCallback } from 'react';
import { Badge, Panel, ResourceView, Stat, StatusBadge } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { apiGet } from '../../lib/api';
import { formatCount, formatTime, humanize, toneOf, type Tone } from '../../lib/format';
import { conversationHref } from '../../lib/route';
import { CampaignActions } from './CampaignActions';

const REFRESH_MS = 30_000;

const ACTIVITY_TONE: Readonly<Record<ActivityKind, Tone>> = {
  OUTBOUND: 'zinc',
  INBOUND: 'amber',
  QUALIFIED: 'emerald',
  NOT_QUALIFIED: 'zinc',
  BOOKING: 'emerald',
  OPT_OUT: 'rose',
  INTEGRATION: 'rose',
};

export function CampaignDetail({ campaignId }: { campaignId: string }) {
  const load = useCallback(
    (signal: AbortSignal) =>
      apiGet<CampaignOverviewResponse>(
        `/api/v1/campaigns/${encodeURIComponent(campaignId)}/overview`,
        { signal },
      ),
    [campaignId],
  );
  const overview = useResource(load, REFRESH_MS);

  return (
    <div className="space-y-4">
      <a href="#/overview" className="text-xs text-zinc-400 hover:text-zinc-200">
        ← All campaigns
      </a>
      <ResourceView resource={overview}>
        {(data) => <Detail data={data} onChanged={overview.reload} />}
      </ResourceView>
    </div>
  );
}

function Detail({ data, onChanged }: { data: CampaignOverviewResponse; onChanged: () => void }) {
  const { campaign, metrics, dispatch, activity } = data;
  const settings = campaign.config;
  const usage =
    dispatch.hourlyLimit === 0
      ? 0
      : Math.min(100, Math.round((dispatch.admittedLastHour / dispatch.hourlyLimit) * 100));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-zinc-50">{campaign.name}</h1>
            <StatusBadge status={campaign.status} />
          </div>
          <p className="text-xs text-zinc-500">
            Created {formatTime(campaign.createdAt)} · status since{' '}
            {formatTime(campaign.statusChangedAt)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={`#/conversations?campaign=${campaign.id}`}
            className="text-xs text-zinc-300 hover:underline"
          >
            Conversations →
          </a>
          <CampaignActions campaign={campaign} onChanged={onChanged} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Performance">
          <dl className="grid grid-cols-2 gap-3 p-4">
            <Stat label="Enrolled" value={formatCount(metrics.enrolled)} />
            <Stat label="Step 1 sent" value={formatCount(metrics.step1Sent)} />
            <Stat label="Outbound sent" value={formatCount(metrics.outboundSent)} />
            <Stat label="Replied leads" value={formatCount(metrics.repliedLeads)} />
            <Stat label="Qualified" value={formatCount(metrics.qualified)} />
            <Stat label="Booked (verified)" value={formatCount(metrics.booked)} />
          </dl>
        </Panel>
        <Panel title="Dispatch capacity">
          <div className="space-y-3 p-4">
            <dl className="grid grid-cols-3 gap-3">
              <Stat label="Admitted, last hour" value={formatCount(dispatch.admittedLastHour)} />
              <Stat label="Hourly limit" value={formatCount(dispatch.hourlyLimit)} />
              <Stat label="Remaining" value={formatCount(dispatch.remainingThisHour)} />
            </dl>
            <div
              role="meter"
              aria-label="Hourly dispatch usage"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={usage}
              className="h-1.5 overflow-hidden rounded bg-zinc-800"
            >
              <div
                className={`h-full ${usage >= 100 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                style={{ width: `${usage}%` }}
              />
            </div>
          </div>
        </Panel>
        <Panel title="Configuration">
          <dl className="grid grid-cols-2 gap-3 p-4">
            <Stat
              label="Send window"
              value={`${settings.sendWindow.start}–${settings.sendWindow.end}`}
            />
            <Stat label="Fallback timezone" value={settings.timezone ?? 'None'} />
            <Stat label="Follow-up delay" value={`${settings.followUpDelayHours} h`} />
            <Stat label="Archive delay" value={`${settings.archiveDelayDays} d`} />
            <Stat
              label="Step 2 closeout"
              value={settings.messages?.step2 === undefined ? 'Not configured' : 'Configured'}
            />
            <Stat
              label="Qualification"
              value={
                settings.qualification === undefined
                  ? 'No rules'
                  : `${settings.qualification.fields.length} fields`
              }
            />
            <Stat label="Booking provider" value={settings.booking?.provider ?? 'None'} />
          </dl>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Lead pipeline">
          <ul className="space-y-2 p-4">
            {CAMPAIGN_LEAD_STATUSES.map((status) => {
              const value = metrics.members[status];
              const width = metrics.enrolled === 0 ? 0 : (value / metrics.enrolled) * 100;
              return (
                <li key={status} className="grid grid-cols-[120px_1fr_48px] items-center gap-3">
                  <StatusBadge status={status} />
                  <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
                    <div
                      className={`h-full ${BAR_TONE[toneOf(status)]}`}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <span className="text-right text-xs text-zinc-300 tabular-nums">
                    {formatCount(value)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
        <Panel title="Recent activity">
          {activity.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-500">No activity yet.</p>
          ) : (
            <ol className="max-h-96 divide-y divide-zinc-800/70 overflow-y-auto">
              {activity.map((item, index) => (
                <li
                  key={`${item.at}-${index}`}
                  className="flex items-center gap-3 px-4 py-2 text-xs"
                >
                  <span className="w-28 shrink-0 text-zinc-500">{formatTime(item.at)}</span>
                  <Badge tone={ACTIVITY_TONE[item.kind]}>{humanize(item.kind)}</Badge>
                  {item.leadId === null ? (
                    <span className="text-zinc-300">{item.leadName}</span>
                  ) : (
                    <a
                      href={conversationHref(item.leadId)}
                      className="text-zinc-200 hover:underline"
                    >
                      {item.leadName}
                    </a>
                  )}
                  <span className="ml-auto truncate font-mono text-[11px] text-zinc-500">
                    {item.detail}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}

const BAR_TONE: Readonly<Record<Tone, string>> = {
  emerald: 'bg-emerald-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-400',
  zinc: 'bg-zinc-500',
};
