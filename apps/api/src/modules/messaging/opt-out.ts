/**
 * Hard opt-out detection. Deliberately narrow: the whole message must be one
 * standard opt-out command, ignoring case, surrounding whitespace, quotes and
 * trailing punctuation. Anything else ("stop texting me", "not now",
 * "who is this?") is left for intent classification (Phase 2 / Prompt 2).
 */
export const HARD_OPT_OUT_COMMANDS = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'REMOVE',
  'CANCEL',
  'END',
  'QUIT',
  'OPTOUT',
  'OPT OUT',
  'OPT-OUT',
  'REVOKE',
] as const;

const LEADING_NOISE = /^["'“”‘’([\s]+/u;
const TRAILING_NOISE = /["'“”‘’.!)\]\s]+$/u;

export function isHardOptOut(body: string): boolean {
  const normalized = body
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_NOISE, '')
    .replace(TRAILING_NOISE, '');
  return (HARD_OPT_OUT_COMMANDS as readonly string[]).includes(normalized);
}
