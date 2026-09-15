/** Emerald success · amber active/attention · rose failure/opt-out · zinc inactive. */
export type Tone = 'emerald' | 'amber' | 'rose' | 'zinc';

const TONES: Readonly<Record<string, Tone>> = {
  BOOKED: 'emerald',
  QUALIFIED: 'emerald',
  CONFIRMED: 'emerald',
  ACCEPTED: 'emerald',
  SENT: 'emerald',
  DELIVERED: 'emerald',
  HEALTHY: 'emerald',
  POSITIVE_INTEREST: 'emerald',
  AUTOMATION_ACTIVE: 'emerald',

  ACTIVE: 'amber',
  QUEUED: 'amber',
  STEP_1_SENT: 'amber',
  STEP_2_SENT: 'amber',
  ENGAGED: 'amber',
  OFFERED: 'amber',
  PENDING: 'amber',
  SENDING: 'amber',
  PROCESSING: 'amber',
  RETRY: 'amber',
  ESCALATED: 'amber',
  BLOCKED: 'amber',
  NOT_CONFIGURED: 'amber',
  HUMAN_TAKEOVER: 'amber',
  PENDING_INFORMATION: 'amber',
  SPECIFIC_QUESTION: 'amber',
  AMBIGUOUS: 'amber',

  OPTED_OUT: 'rose',
  FAILED: 'rose',
  FAILING: 'rose',
  UNCERTAIN: 'rose',
  HARD_OPT_OUT: 'rose',
  NOT_INTERESTED: 'rose',
  NOT_QUALIFIED: 'rose',
};

export function toneOf(status: string): Tone {
  return TONES[status] ?? 'zinc';
}

export const TEXT_TONE: Readonly<Record<Tone, string>> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  rose: 'text-rose-300',
  zinc: 'text-zinc-50',
};

export function humanize(value: string): string {
  return value.replaceAll('_', ' ');
}

const count = new Intl.NumberFormat('en-US');
const dateTime = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatCount(value: number): string {
  return count.format(value);
}

export function formatRate(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function formatTime(iso: string | null): string {
  return iso === null ? '—' : dateTime.format(new Date(iso));
}

/** Appointment time in its own timezone, falling back to the viewer's zone. */
export function formatInZone(iso: string | null, timeZone: string | null): string {
  if (iso === null) return '—';
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone === null ? {} : { timeZone }),
    }).format(new Date(iso));
    return timeZone === null ? formatted : `${formatted} (${timeZone})`;
  } catch {
    return formatTime(iso);
  }
}
