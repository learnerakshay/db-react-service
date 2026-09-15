import type { DashboardOverview, OverviewMetrics } from '@cadentor/shared';
import { ResourceView, Kpi, RefreshControl } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { apiGet } from '../../lib/api';
import { formatCount, formatRate } from '../../lib/format';
import { CampaignTable } from '../campaigns/CampaignTable';
import { IntegrationHealthPanel } from '../integrations/IntegrationHealthPanel';

const REFRESH_MS = 30_000;

const loadOverview = (signal: AbortSignal) =>
  apiGet<DashboardOverview>('/api/v1/dashboard/overview', { signal });

export function OverviewPage() {
  const overview = useResource(loadOverview, REFRESH_MS);
  return (
    <div className="space-y-5">
      <section aria-label="Key metrics" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-base font-semibold text-zinc-50">Overview</h1>
          <RefreshControl resource={overview} at={overview.data?.generatedAt ?? null} />
        </div>
        <div className="rounded-lg">
          <ResourceView resource={overview}>
            {({ metrics }) => <KpiGrid metrics={metrics} />}
          </ResourceView>
        </div>
      </section>
      <CampaignTable />
      <IntegrationHealthPanel />
    </div>
  );
}

function KpiGrid({ metrics: m }: { metrics: OverviewMetrics }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="Total ingested"
          value={formatCount(m.totalIngested)}
          hint="Unique leads from imports"
        />
        <Kpi
          label="Outbound sent"
          value={formatCount(m.outboundSent)}
          hint="Accepted by the SMS provider"
        />
        <Kpi
          label="Reply rate"
          value={formatRate(m.replyRate)}
          hint={`${formatCount(m.repliedLeads)} of ${formatCount(m.contactedLeads)} contacted leads`}
        />
        <Kpi
          label="Positive intent"
          value={formatCount(m.positiveIntentLeads)}
          hint="Leads, validated classification"
          tone="emerald"
        />
        <Kpi
          label="Qualified"
          value={formatCount(m.qualified)}
          hint="Memberships that reached qualified"
          tone="emerald"
        />
        <Kpi
          label="Appointments booked"
          value={formatCount(m.booked)}
          hint="Verified calendar confirmations"
          tone="emerald"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi
          label="Active campaigns"
          value={formatCount(m.activeCampaigns)}
          hint="Status ACTIVE"
          tone="amber"
        />
        <Kpi
          label="Human reviews"
          value={formatCount(m.openReviews)}
          hint="Unresolved escalations"
          tone={m.openReviews > 0 ? 'amber' : 'zinc'}
        />
        <Kpi
          label="Opt-out rate"
          value={formatRate(m.optOutRate)}
          hint={`${formatCount(m.optedOutLeads)} contacted leads opted out`}
          tone={m.optedOutLeads > 0 ? 'rose' : 'zinc'}
        />
      </div>
    </div>
  );
}
