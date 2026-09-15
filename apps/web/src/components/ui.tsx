import type { ReactNode } from 'react';
import type { Resource } from '../hooks/useResource';
import { formatTime, humanize, TEXT_TONE, toneOf, type Tone } from '../lib/format';
import { ErrorNotice, LoadingIndicator } from './Feedback';

const BADGE_TONE: Readonly<Record<Tone, string>> = {
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  rose: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  zinc: 'border-zinc-700 bg-zinc-800/60 text-zinc-300',
};

export function Badge({ children, tone = 'zinc' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded border px-1.5 py-px text-[11px] font-medium tracking-wide ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status, tone }: { status: string; tone?: Tone }) {
  return <Badge tone={tone ?? toneOf(status)}>{humanize(status)}</Badge>;
}

const BUTTON_VARIANT = {
  default: 'border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700',
  primary: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25',
  warning: 'border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25',
  danger: 'border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25',
} as const;

export function Button({
  children,
  onClick,
  disabled = false,
  variant = 'default',
  label,
  autoFocus = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: keyof typeof BUTTON_VARIANT;
  /** Accessible name when the visible text is ambiguous (e.g. per-row actions). */
  label?: string;
  autoFocus?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      autoFocus={autoFocus}
      onClick={onClick}
      className={`rounded border px-2 py-1 text-xs font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_VARIANT[variant]}`}
    >
      {children}
    </button>
  );
}

export function Panel({
  title,
  actions,
  children,
  className = '',
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={`min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 ${className}`}
    >
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2">
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-zinc-500">{children}</p>;
}

/**
 * Renders loading, error, empty and partial-data states for a resource.
 * A failed refresh keeps the last loaded data visible with a warning.
 */
export function ResourceView<T>({
  resource,
  isEmpty,
  empty,
  children,
}: {
  resource: Resource<T>;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { data, error } = resource;
  if (data === undefined) {
    return (
      <div className="px-4 py-4">
        {error === undefined ? <LoadingIndicator /> : <ErrorNotice message={error.message} />}
      </div>
    );
  }
  return (
    <>
      {error !== undefined && (
        <div className="border-b border-zinc-800 px-4 py-2">
          <ErrorNotice message={`Refresh failed, showing last loaded data: ${error.message}`} />
        </div>
      )}
      {isEmpty?.(data) === true ? <EmptyState>{empty}</EmptyState> : children(data)}
    </>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-4 py-2 text-xs text-zinc-400"
    >
      <span className="tabular-nums">
        {first}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button
          disabled={page <= 1}
          onClick={() => {
            onPage(page - 1);
          }}
        >
          Previous
        </Button>
        <span className="tabular-nums">
          Page {page} of {pages}
        </span>
        <Button
          disabled={page >= pages}
          onClick={() => {
            onPage(page + 1);
          }}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

/** Inline confirmation for terminal or consequential actions. */
export function ConfirmPrompt({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={confirmLabel}
      className="flex flex-wrap items-center gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-100"
    >
      <span>{message}</span>
      <Button variant="danger" disabled={busy} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button disabled={busy} onClick={onCancel} autoFocus>
        Cancel
      </Button>
    </div>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone = 'zinc',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: Tone;
}) {
  return (
    <dl className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
      <dt className="text-xs font-medium text-zinc-400">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold tabular-nums ${TEXT_TONE[tone]}`}>{value}</dd>
      <dd className="mt-0.5 text-[11px] text-zinc-500">{hint}</dd>
    </dl>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className="truncate text-sm font-medium text-zinc-100 tabular-nums">{value}</dd>
    </div>
  );
}

export function RefreshControl({
  resource,
  at,
}: {
  resource: Resource<unknown>;
  at: string | null;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-zinc-500">
      <span aria-live="polite">
        {resource.loading ? 'Refreshing…' : `Updated ${formatTime(at)}`}
      </span>
      <Button onClick={resource.reload} disabled={resource.loading}>
        Refresh
      </Button>
    </div>
  );
}
