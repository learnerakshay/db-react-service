import { CampaignDetail } from '../features/campaigns/CampaignDetail';
import { ConversationsPage } from '../features/conversations/ConversationsPage';
import { OverviewPage } from '../features/overview/OverviewPage';
import { ReviewsPage } from '../features/reviews/ReviewsPage';
import { useHashRoute, type Route } from '../lib/route';

const NAV: readonly { href: string; label: string; views: readonly Route['view'][] }[] = [
  { href: '#/overview', label: 'Overview', views: ['overview', 'campaign'] },
  { href: '#/conversations', label: 'Conversations', views: ['conversations'] },
  { href: '#/reviews', label: 'Human review', views: ['reviews'] },
];

/** Operator console: a window onto backend truth. All figures come from the API. */
export function MissionControl() {
  const route = useHashRoute();

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-x-8 gap-y-2 px-6 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight text-zinc-50">Cadentor</span>
            <span className="text-xs text-zinc-500">Mission Control</span>
          </div>
          <nav aria-label="Primary" className="flex gap-1">
            {NAV.map((item) => {
              const active = item.views.includes(route.view);
              return (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded px-3 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-amber-400 ${active ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-100'}`}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1680px] px-6 py-5">
        {route.view === 'overview' && <OverviewPage />}
        {route.view === 'campaign' && (
          <CampaignDetail key={route.campaignId} campaignId={route.campaignId} />
        )}
        {route.view === 'conversations' && (
          <ConversationsPage leadId={route.leadId} campaignId={route.campaignId} />
        )}
        {route.view === 'reviews' && <ReviewsPage />}
      </main>
    </div>
  );
}
