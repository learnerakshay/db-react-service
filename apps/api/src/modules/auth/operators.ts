import type { OperatorIdentity, OperatorRole } from '@cadentor/shared';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { OperatorCredential } from '../../config/operators.js';

export type Operator = OperatorIdentity;

const RANK: Readonly<Record<OperatorRole, number>> = { OPERATOR: 1, ADMIN: 2 };

export function hashOperatorToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Resolve a bearer token to an operator. Compares SHA-256 digests in constant
 * time against every configured credential, so timing does not reveal which
 * (or whether any) operator matched.
 */
export function authenticateOperatorToken(
  credentials: readonly OperatorCredential[],
  token: string,
): Operator | null {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  let match: OperatorCredential | null = null;
  for (const credential of credentials) {
    const equal = timingSafeEqual(digest, Buffer.from(credential.tokenSha256, 'hex'));
    if (equal && match === null) match = credential;
  }
  return match === null ? null : { id: match.id, role: match.role };
}

export function hasRole(operator: Operator, required: OperatorRole): boolean {
  return RANK[operator.role] >= RANK[required];
}
