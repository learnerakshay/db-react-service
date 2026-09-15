-- CreateEnum
CREATE TYPE "ReviewResolution" AS ENUM ('RESUME_AUTOMATION', 'KEEP_HUMAN_TAKEOVER', 'ARCHIVE', 'MARK_HANDLED');

-- CreateEnum
CREATE TYPE "OperatorAction" AS ENUM ('CAMPAIGN_START', 'CAMPAIGN_PAUSE', 'CAMPAIGN_RESUME', 'CAMPAIGN_COMPLETE', 'HUMAN_TAKEOVER', 'RESUME_AUTOMATION', 'REVIEW_RESOLVED', 'INTEGRATION_REQUEUE');

-- CreateEnum
CREATE TYPE "AuditTargetType" AS ENUM ('CAMPAIGN', 'LEAD', 'REVIEW', 'INTEGRATION');

-- AlterTable
ALTER TABLE "ReplyProcessing" ADD COLUMN     "reviewNote" VARCHAR(500),
ADD COLUMN     "reviewResolution" "ReviewResolution",
ADD COLUMN     "reviewResolvedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewResolvedBy" VARCHAR(64);

-- CreateTable
CREATE TABLE "OperatorAuditEvent" (
    "id" UUID NOT NULL,
    "actorId" VARCHAR(64) NOT NULL,
    "actorRole" VARCHAR(16) NOT NULL,
    "action" "OperatorAction" NOT NULL,
    "targetType" "AuditTargetType" NOT NULL,
    "targetId" VARCHAR(64) NOT NULL,
    "metadata" JSONB NOT NULL,
    "requestId" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperatorAuditEvent_createdAt_idx" ON "OperatorAuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "OperatorAuditEvent_targetType_targetId_createdAt_idx" ON "OperatorAuditEvent"("targetType", "targetId", "createdAt");

-- ---------------------------------------------------------------------------
-- Hand-written invariants (not expressible in schema.prisma).
-- See docs/database.md. Keep these when generating future migrations.
-- ---------------------------------------------------------------------------

-- Review resolution: only escalated records can be resolved, and a resolution
-- is recorded completely (when, how, by whom) or not at all.
ALTER TABLE "ReplyProcessing" ADD CONSTRAINT "ReplyProcessing_review_resolution_check" CHECK (
  ("reviewResolvedAt" IS NULL AND "reviewResolution" IS NULL AND "reviewResolvedBy" IS NULL AND "reviewNote" IS NULL)
  OR ("status" = 'ESCALATED' AND "reviewResolvedAt" IS NOT NULL
      AND "reviewResolution" IS NOT NULL AND "reviewResolvedBy" IS NOT NULL)
);

-- Open reviews per lead: what automation blocking and the review queue look up.
CREATE INDEX "ReplyProcessing_open_review_lead_idx" ON "ReplyProcessing" ("leadId")
  WHERE "status" = 'ESCALATED' AND "reviewResolvedAt" IS NULL;

-- Operator audit is append-only: history can be added to, never rewritten.
CREATE FUNCTION "operator_audit_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OperatorAuditEvent is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "OperatorAuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "OperatorAuditEvent"
FOR EACH ROW EXECUTE FUNCTION "operator_audit_event_append_only"();
