import type { AuditEventDto, AuditTargetType, OperatorAction, Page } from '@cadentor/shared';
import type { DbClient } from '../../db/client.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Operator } from '../auth/operators.js';

/** Identifiers, counts and enum values only: no credentials, contact data or message text. */
export type AuditMetadata = Record<string, string | number | boolean | null>;

export interface OperatorActionRecord {
  actor: Operator;
  action: OperatorAction;
  targetType: AuditTargetType;
  targetId: string;
  metadata?: AuditMetadata;
  requestId?: string | undefined;
}

/**
 * Append one operator audit event. Call it inside the transaction that applies
 * the action, and only when the action changed something, so a repeated or
 * rejected request never produces an audit record. Rows are append-only (trigger).
 */
export async function recordOperatorAction(
  tx: DbClient,
  record: OperatorActionRecord,
): Promise<void> {
  await tx.operatorAuditEvent.create({
    data: {
      actorId: record.actor.id,
      actorRole: record.actor.role,
      action: record.action,
      targetType: record.targetType,
      targetId: record.targetId,
      metadata: record.metadata ?? {},
      requestId: record.requestId ?? null,
    },
  });
}

/** Newest first, id tiebreak. */
export async function listAuditEvents(
  db: DbClient,
  query: {
    page: number;
    pageSize: number;
    targetType?: AuditTargetType | undefined;
    targetId?: string | undefined;
  },
): Promise<Page<AuditEventDto>> {
  const where: Prisma.OperatorAuditEventWhereInput = {
    ...(query.targetType === undefined ? {} : { targetType: query.targetType }),
    ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
  };
  const [total, rows] = await Promise.all([
    db.operatorAuditEvent.count({ where }),
    db.operatorAuditEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    items: rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorRole: row.actorRole,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: toMetadata(row.metadata),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

function toMetadata(value: Prisma.JsonValue): AuditMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const metadata: AuditMetadata = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    ) {
      metadata[key] = entry;
    }
  }
  return metadata;
}
