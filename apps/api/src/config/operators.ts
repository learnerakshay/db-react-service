import type { OperatorRole } from '@cadentor/shared';

/** One configured operator. Only the SHA-256 of the bearer token is ever held. */
export interface OperatorCredential {
  id: string;
  role: OperatorRole;
  /** Lowercase hex SHA-256 of the token. */
  tokenSha256: string;
}

export type OperatorTokensResult =
  { ok: true; operators: OperatorCredential[] } | { ok: false; message: string };

const ENTRY = /^([a-z0-9][a-z0-9._-]{0,63}):(OPERATOR|ADMIN):([0-9a-fA-F]{64})$/;

/**
 * OPERATOR_TOKENS = "<id>:<OPERATOR|ADMIN>:<sha256 hex of token>" entries,
 * comma-separated. Generate entries with `npm run operator:token -- <id> <role>`.
 * Messages never include hashes.
 */
export function parseOperatorTokens(raw: string | undefined): OperatorTokensResult {
  if (raw === undefined) return { ok: true, operators: [] };
  const operators: OperatorCredential[] = [];
  const entries = raw.split(',').map((entry) => entry.trim());
  for (const [index, entry] of entries.entries()) {
    const match = ENTRY.exec(entry);
    if (match?.[1] === undefined || match[3] === undefined) {
      return {
        ok: false,
        message: `entry ${index + 1} must be <id>:<OPERATOR|ADMIN>:<64-hex sha256>`,
      };
    }
    operators.push({
      id: match[1],
      role: match[2] === 'ADMIN' ? 'ADMIN' : 'OPERATOR',
      tokenSha256: match[3].toLowerCase(),
    });
  }
  if (new Set(operators.map((o) => o.id)).size !== operators.length) {
    return { ok: false, message: 'operator ids must be unique' };
  }
  if (new Set(operators.map((o) => o.tokenSha256)).size !== operators.length) {
    return { ok: false, message: 'each operator must have its own token' };
  }
  return { ok: true, operators };
}
