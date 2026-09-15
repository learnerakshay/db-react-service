import {
  ESCALATION_REASONS,
  REVIEW_RESOLUTIONS,
  type EscalationReason,
  type Page,
  type ReviewItem,
  type ReviewResolution,
  type ReviewResolutionResponse,
  type ReviewState,
} from '@cadentor/shared';
import { Fragment, useCallback, useState, type SyntheticEvent } from 'react';
import { ErrorNotice } from '../../components/Feedback';
import { Button, Pager, Panel, ResourceView, StatusBadge } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { apiGet, apiPost, describeError } from '../../lib/api';
import { formatTime, humanize } from '../../lib/format';
import { conversationHref } from '../../lib/route';

const PAGE_SIZE = 25;
const REFRESH_MS = 20_000;
const COLUMNS = 10;

const RESOLUTION_HELP: Readonly<Record<ReviewResolution, string>> = {
  RESUME_AUTOMATION: 'Resolve and resume automation for this lead.',
  KEEP_HUMAN_TAKEOVER: 'Resolve and keep automation paused; you continue manually.',
  ARCHIVE: 'Resolve and archive this campaign membership; an open booking link is withdrawn.',
  MARK_HANDLED: 'Resolve without changing automation.',
};

const selectClass = 'rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100';

export function ReviewsPage() {
  const [state, setState] = useState<ReviewState>('OPEN');
  const [reason, setReason] = useState<EscalationReason | ''>('');
  const [page, setPage] = useState(1);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(
    (signal: AbortSignal) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        state,
      });
      if (reason !== '') params.set('reason', reason);
      return apiGet<Page<ReviewItem>>(`/api/v1/reviews?${params.toString()}`, { signal });
    },
    [page, reason, state],
  );
  const reviews = useResource(load, REFRESH_MS);

  return (
    <Panel
      title="Human review queue"
      actions={
        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
          <label className="flex items-center gap-2">
            State
            <select
              value={state}
              onChange={(event) => {
                setState(event.target.value === 'RESOLVED' ? 'RESOLVED' : 'OPEN');
                setPage(1);
                setResolving(null);
              }}
              className={selectClass}
            >
              <option value="OPEN">Open</option>
              <option value="RESOLVED">Resolved</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            Reason
            <select
              value={reason}
              onChange={(event) => {
                setReason(ESCALATION_REASONS.find((r) => r === event.target.value) ?? '');
                setPage(1);
              }}
              className={selectClass}
            >
              <option value="">All reasons</option>
              {ESCALATION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </select>
          </label>
        </div>
      }
    >
      <p className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500">
        {state === 'OPEN'
          ? 'Unresolved escalations, newest first. Opening an item does not resolve it; resolving closes every open review of that lead.'
          : 'Resolved escalations, newest first. History is kept.'}
      </p>
      <ResourceView
        resource={reviews}
        isEmpty={(data) => data.total === 0}
        empty={
          state === 'OPEN'
            ? 'No conversations are waiting for human review.'
            : 'No resolved reviews yet.'
        }
      >
        {(data) => (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1200px] text-left text-xs">
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
                    <th className="px-3 py-2 text-right font-medium">Resolution</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {data.items.map((item) => (
                    <Fragment key={item.processingId}>
                      <tr className="align-top hover:bg-zinc-800/30">
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
                        <td className="px-3 py-2 text-right">
                          {item.resolution !== null ? (
                            <div className="space-y-0.5">
                              <StatusBadge status={item.resolution.type} tone="emerald" />
                              <p className="text-[11px] text-zinc-500">
                                {item.resolution.resolvedBy} ·{' '}
                                {formatTime(item.resolution.resolvedAt)}
                              </p>
                            </div>
                          ) : resolving === item.processingId ? null : (
                            <Button
                              variant="warning"
                              label={`Resolve review for ${item.leadName}`}
                              onClick={() => {
                                setResolving(item.processingId);
                              }}
                            >
                              Resolve
                            </Button>
                          )}
                        </td>
                      </tr>
                      {resolving === item.processingId && item.resolution === null && (
                        <tr>
                          <td colSpan={COLUMNS} className="bg-zinc-950/60 px-3 py-3">
                            <ResolveReviewForm
                              item={item}
                              onCancel={() => {
                                setResolving(null);
                              }}
                              onResolved={() => {
                                setResolving(null);
                                reviews.reload();
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
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

function ResolveReviewForm({
  item,
  onCancel,
  onResolved,
}: {
  item: ReviewItem;
  onCancel: () => void;
  onResolved: () => void;
}) {
  const options = REVIEW_RESOLUTIONS.filter(
    (resolution) =>
      (item.leadId !== null ||
        (resolution !== 'RESUME_AUTOMATION' && resolution !== 'KEEP_HUMAN_TAKEOVER')) &&
      (resolution !== 'ARCHIVE' || item.membershipStatus !== null),
  );
  const [resolution, setResolution] = useState<ReviewResolution>('MARK_HANDLED');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      await apiPost<ReviewResolutionResponse>(`/api/v1/reviews/${item.processingId}/resolve`, {
        resolution,
        ...(trimmed === '' ? {} : { note: trimmed }),
      });
      onResolved();
    } catch (err) {
      setError(describeError(err instanceof Error ? err : new Error(String(err))));
      setBusy(false);
    }
  };

  return (
    <form
      aria-label={`Resolve review for ${item.leadName}`}
      onSubmit={(event) => {
        void submit(event);
      }}
      className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
    >
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-[11px] font-medium text-zinc-400">Resolution</legend>
        {options.map((option) => (
          <label key={option} className="flex items-start gap-2 text-xs text-zinc-300">
            <input
              type="radio"
              name={`resolution-${item.processingId}`}
              value={option}
              checked={resolution === option}
              onChange={() => {
                setResolution(option);
              }}
              className="mt-0.5 accent-amber-400"
            />
            <span>
              <span className="font-medium text-zinc-100">{humanize(option)}</span>
              <span className="block text-[11px] text-zinc-500">{RESOLUTION_HELP[option]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="space-y-2">
        <label className="block space-y-1 text-[11px] text-zinc-400">
          <span>Note (optional, no contact details)</span>
          <textarea
            value={note}
            maxLength={500}
            rows={3}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
          />
        </label>
        {error !== null && <ErrorNotice message={error} />}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className={`rounded border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${resolution === 'ARCHIVE' ? 'border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25' : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'}`}
          >
            {busy ? 'Resolving…' : `Confirm ${humanize(resolution).toLowerCase()}`}
          </button>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}
