import {
  type AutomationChangeResponse,
  type AutomationState,
  type ConversationDetail,
  type ConversationFilter,
  type ConversationListItem,
  type ConversationMessage,
  type LeadDetail,
  type Page,
} from '@cadentor/shared';
import { useCallback, useState } from 'react';
import { ErrorNotice } from '../../components/Feedback';
import {
  Badge,
  Button,
  ConfirmPrompt,
  EmptyState,
  Pager,
  Panel,
  ResourceView,
  StatusBadge,
} from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { apiGet, apiPost } from '../../lib/api';
import { formatTime, humanize } from '../../lib/format';
import { conversationHref } from '../../lib/route';
import { LeadDetailView } from './LeadDetailView';

const PAGE_SIZE = 25;
const LIST_REFRESH_MS = 20_000;
const DETAIL_REFRESH_MS = 20_000;

const FILTERS: readonly { value: ConversationFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'takeover', label: 'Human takeover' },
];

export function ConversationsPage({
  leadId,
  campaignId,
}: {
  leadId: string | null;
  campaignId: string | null;
}) {
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [page, setPage] = useState(1);

  const load = useCallback(
    (signal: AbortSignal) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        filter,
      });
      if (campaignId !== null) params.set('campaignId', campaignId);
      return apiGet<Page<ConversationListItem>>(`/api/v1/conversations?${params.toString()}`, {
        signal,
      });
    },
    [page, filter, campaignId],
  );
  const list = useResource(load, LIST_REFRESH_MS);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)_380px]">
      <Panel
        title="Conversations"
        actions={
          <div role="group" aria-label="Filter conversations" className="flex gap-1">
            {FILTERS.map((option) => (
              <Button
                key={option.value}
                variant={filter === option.value ? 'warning' : 'default'}
                onClick={() => {
                  setFilter(option.value);
                  setPage(1);
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        }
      >
        {campaignId !== null && (
          <p className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
            One campaign only ·{' '}
            <a href="#/conversations" className="text-zinc-200 hover:underline">
              show all
            </a>
          </p>
        )}
        <ResourceView
          resource={list}
          isEmpty={(data) => data.total === 0}
          empty={filter === 'all' ? 'No conversations yet.' : 'Nothing needs attention.'}
        >
          {(data) => (
            <>
              <ul className="max-h-[70vh] divide-y divide-zinc-800/70 overflow-y-auto">
                {data.items.map((item) => (
                  <ConversationRow
                    key={item.leadId}
                    item={item}
                    selected={item.leadId === leadId}
                    campaignId={campaignId}
                  />
                ))}
              </ul>
              <Pager
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPage={setPage}
              />
            </>
          )}
        </ResourceView>
      </Panel>

      {leadId === null ? (
        <Panel title="Conversation">
          <EmptyState>Select a conversation to inspect it.</EmptyState>
        </Panel>
      ) : (
        <SelectedLead key={leadId} leadId={leadId} onChanged={list.reload} />
      )}
    </div>
  );
}

function ConversationRow({
  item,
  selected,
  campaignId,
}: {
  item: ConversationListItem;
  selected: boolean;
  campaignId: string | null;
}) {
  const takeover = item.automation.mode === 'HUMAN_TAKEOVER';
  const attention = takeover || item.openReviews > 0;
  return (
    <li>
      <a
        href={conversationHref(item.leadId, campaignId)}
        aria-current={selected ? 'true' : undefined}
        className={`block px-4 py-2.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-400 ${selected ? 'bg-zinc-800/70' : 'hover:bg-zinc-800/30'}`}
      >
        <div className="flex items-center gap-2">
          {attention && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
              aria-label="Needs attention"
              role="img"
            />
          )}
          <span className="truncate text-sm font-medium text-zinc-100">{item.leadName}</span>
          <span className="text-[11px] text-zinc-500">••{item.phoneLast4}</span>
          <span className="ml-auto shrink-0 text-[11px] text-zinc-500">
            {formatTime(item.lastMessage.at)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {item.membershipStatus !== null && <StatusBadge status={item.membershipStatus} />}
          {takeover && <StatusBadge status="HUMAN_TAKEOVER" />}
          {item.openReviews > 0 && <Badge tone="amber">{item.openReviews} review</Badge>}
          <span className="truncate text-[11px] text-zinc-500">
            {item.campaign?.name ?? 'No campaign'}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-zinc-400">
          <span className="text-zinc-500">
            {item.lastMessage.direction === 'INBOUND' ? '← ' : '→ '}
          </span>
          {item.lastMessage.preview ?? humanize(item.lastMessage.purpose)}
        </p>
      </a>
    </li>
  );
}

function SelectedLead({ leadId, onChanged }: { leadId: string; onChanged: () => void }) {
  const loadThread = useCallback(
    (signal: AbortSignal) =>
      apiGet<ConversationDetail>(`/api/v1/conversations/${encodeURIComponent(leadId)}`, { signal }),
    [leadId],
  );
  const loadLead = useCallback(
    (signal: AbortSignal) =>
      apiGet<LeadDetail>(`/api/v1/leads/${encodeURIComponent(leadId)}`, { signal }),
    [leadId],
  );
  const thread = useResource(loadThread, DETAIL_REFRESH_MS);
  const lead = useResource(loadLead, DETAIL_REFRESH_MS);
  const { reload: reloadThread } = thread;
  const { reload: reloadLead } = lead;
  const refresh = useCallback(() => {
    reloadThread();
    reloadLead();
    onChanged();
  }, [reloadThread, reloadLead, onChanged]);

  return (
    <>
      <Panel
        title={
          thread.data === undefined ? 'Conversation' : `Conversation · ${thread.data.lead.name}`
        }
        actions={
          thread.data !== undefined && (
            <AutomationControl
              leadId={leadId}
              automation={thread.data.lead.automation}
              onChanged={refresh}
            />
          )
        }
      >
        <ResourceView
          resource={thread}
          isEmpty={(data) => data.messages.length === 0}
          empty="No messages for this lead."
        >
          {(data) => (
            <>
              {data.hasEarlier && (
                <p className="border-b border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
                  Showing the latest {data.messages.length} messages.
                </p>
              )}
              <ol
                aria-label="Message history"
                className="max-h-[70vh] space-y-3 overflow-y-auto p-4"
              >
                {data.messages.map((message) => (
                  <MessageItem key={message.id} message={message} />
                ))}
              </ol>
            </>
          )}
        </ResourceView>
      </Panel>
      <Panel title="Lead" className="lg:col-start-2 2xl:col-start-auto">
        <ResourceView resource={lead}>{(data) => <LeadDetailView lead={data} />}</ResourceView>
      </Panel>
    </>
  );
}

export function AutomationControl({
  leadId,
  automation,
  onChanged,
}: {
  leadId: string;
  automation: AutomationState;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takeover = automation.mode === 'HUMAN_TAKEOVER';

  const run = async (path: 'takeover' | 'resume-automation') => {
    setBusy(true);
    setError(null);
    try {
      await apiPost<AutomationChangeResponse>(
        `/api/v1/leads/${encodeURIComponent(leadId)}/${path}`,
      );
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span title={takeover ? `Since ${formatTime(automation.pausedAt)}` : undefined}>
        <StatusBadge status={automation.mode} />
      </span>
      {confirming ? (
        <ConfirmPrompt
          message="Resume automated messages for this lead? Its open reviews are resolved; suppression and closed conversations still stop sends."
          confirmLabel="Resume automation"
          busy={busy}
          onConfirm={() => {
            void run('resume-automation');
          }}
          onCancel={() => {
            setConfirming(false);
          }}
        />
      ) : takeover ? (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Resume automation
        </Button>
      ) : (
        <Button
          variant="warning"
          disabled={busy}
          onClick={() => {
            void run('takeover');
          }}
        >
          Take over
        </Button>
      )}
      {error !== null && <ErrorNotice message={error} />}
    </div>
  );
}

function MessageItem({ message: m }: { message: ConversationMessage }) {
  const outbound = m.direction === 'OUTBOUND';
  return (
    <li className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
      <article
        aria-label={`${outbound ? 'Outbound' : 'Inbound'} message`}
        className={`max-w-[85%] rounded-lg border px-3 py-2 ${outbound ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-800 bg-zinc-950'}`}
      >
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
          <span className="font-semibold text-zinc-300">{outbound ? 'OUTBOUND' : 'INBOUND'}</span>
          <span>{formatTime(m.at)}</span>
          <span>· {humanize(m.purpose)}</span>
          <StatusBadge status={m.status} />
        </div>
        <p className="text-sm break-words whitespace-pre-wrap text-zinc-100">
          {m.body ?? (
            <span className="text-zinc-500 italic">No text (cancelled before rendering)</span>
          )}
        </p>
        {m.errorCode !== null && (
          <p className="mt-1 font-mono text-[11px] text-rose-300">{m.errorCode}</p>
        )}
        {m.reply !== null && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-zinc-800 pt-1.5 text-[11px] text-zinc-400">
            {m.reply.classification !== null && <StatusBadge status={m.reply.classification} />}
            {m.reply.confidence !== null && (
              <span className="tabular-nums">
                {Math.round(m.reply.confidence * 100)}% confidence
              </span>
            )}
            {m.reply.action !== null && <span>→ {humanize(m.reply.action)}</span>}
            {m.reply.escalationReason !== null && (
              <Badge tone="amber">Review: {humanize(m.reply.escalationReason)}</Badge>
            )}
            {m.reply.status !== 'COMPLETED' && m.reply.status !== 'ESCALATED' && (
              <StatusBadge status={m.reply.status} />
            )}
          </div>
        )}
        {m.qualification !== null && (
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
            Qualification <StatusBadge status={m.qualification.result} />
            {m.qualification.missingFields.length > 0 &&
              `missing ${m.qualification.missingFields.join(', ')}`}
          </p>
        )}
        {m.booking !== null && (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-400">
            Booking link <StatusBadge status={m.booking.status} />
          </p>
        )}
      </article>
    </li>
  );
}
