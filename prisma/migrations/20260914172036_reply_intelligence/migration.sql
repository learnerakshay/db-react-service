-- CreateEnum
CREATE TYPE "IntentClassification" AS ENUM ('POSITIVE_INTEREST', 'SPECIFIC_QUESTION', 'NOT_INTERESTED', 'HARD_OPT_OUT', 'AMBIGUOUS');

-- CreateEnum
CREATE TYPE "ReplyProcessingStatus" AS ENUM ('PROCESSING', 'RETRY', 'COMPLETED', 'ESCALATED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ReplyAction" AS ENUM ('OPT_OUT', 'ENGAGE', 'ANSWER_QUESTION', 'CLOSE_DECLINED', 'CLARIFY', 'HUMAN_REVIEW');

-- CreateEnum
CREATE TYPE "EscalationReason" AS ENUM ('LOW_CONFIDENCE', 'UNKNOWN_SENDER', 'AMBIGUOUS_CAMPAIGN', 'NO_CAMPAIGN', 'CONVERSATION_CLOSED', 'AWAITING_HUMAN_REVIEW', 'NO_REPLY_TEMPLATE', 'AMBIGUOUS_REPLY', 'MISSING_KNOWLEDGE', 'UNGROUNDED_ANSWER', 'INVALID_AI_OUTPUT', 'AI_UNAVAILABLE', 'LEAD_SUPPRESSED', 'INBOUND_TOO_OLD');

-- CreateEnum
CREATE TYPE "KnowledgeCategory" AS ENUM ('BUSINESS_PROFILE', 'SERVICES', 'PRICING', 'HOURS', 'LOCATION', 'ELIGIBILITY', 'POLICY', 'INSURANCE', 'FAQ', 'APPROVED_CLAIM', 'BOOKING_PROCESS');

-- AlterEnum
ALTER TYPE "MessagePurpose" ADD VALUE 'CONVERSATIONAL_REPLY';

-- CreateTable
CREATE TABLE "ReplyProcessing" (
    "id" UUID NOT NULL,
    "inboundMessageId" UUID NOT NULL,
    "leadId" UUID,
    "campaignLeadId" UUID,
    "status" "ReplyProcessingStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "claimedAt" TIMESTAMPTZ(3) NOT NULL,
    "classification" "IntentClassification",
    "confidence" DOUBLE PRECISION,
    "preferredTime" VARCHAR(200),
    "specificQuery" VARCHAR(500),
    "action" "ReplyAction",
    "escalationReason" "EscalationReason",
    "knowledgeItemIds" TEXT[],
    "aiProvider" VARCHAR(32),
    "aiModel" VARCHAR(100),
    "aiRequestIds" TEXT[],
    "replyMessageId" UUID,
    "errorCode" VARCHAR(64),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReplyProcessing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeItem" (
    "id" UUID NOT NULL,
    "campaignId" UUID,
    "category" "KnowledgeCategory" NOT NULL,
    "question" VARCHAR(300),
    "content" VARCHAR(2000) NOT NULL,
    "keywords" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "KnowledgeItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReplyProcessing_inboundMessageId_key" ON "ReplyProcessing"("inboundMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyProcessing_replyMessageId_key" ON "ReplyProcessing"("replyMessageId");

-- CreateIndex
CREATE INDEX "ReplyProcessing_status_claimedAt_idx" ON "ReplyProcessing"("status", "claimedAt");

-- CreateIndex
CREATE INDEX "ReplyProcessing_leadId_status_idx" ON "ReplyProcessing"("leadId", "status");

-- CreateIndex
CREATE INDEX "ReplyProcessing_campaignLeadId_action_idx" ON "ReplyProcessing"("campaignLeadId", "action");

-- CreateIndex
CREATE INDEX "KnowledgeItem_active_campaignId_idx" ON "KnowledgeItem"("active", "campaignId");

-- CreateIndex
CREATE INDEX "Message_direction_createdAt_idx" ON "Message"("direction", "createdAt");

-- AddForeignKey
ALTER TABLE "ReplyProcessing" ADD CONSTRAINT "ReplyProcessing_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyProcessing" ADD CONSTRAINT "ReplyProcessing_replyMessageId_fkey" FOREIGN KEY ("replyMessageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyProcessing" ADD CONSTRAINT "ReplyProcessing_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyProcessing" ADD CONSTRAINT "ReplyProcessing_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeItem" ADD CONSTRAINT "KnowledgeItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (not expressible in schema.prisma).
-- See docs/database.md. Keep these when generating future migrations.
-- ---------------------------------------------------------------------------

-- Conversational replies are one per inbound message (UNIQUE sendKey), so a
-- membership can receive many of them. Step 1 stays one per membership.
DROP INDEX "Message_outbound_membership_purpose_key";
CREATE UNIQUE INDEX "Message_outbound_step1_membership_key"
  ON "Message"("campaignLeadId") WHERE "direction" = 'OUTBOUND' AND "purpose" = 'CAMPAIGN_STEP_1';

-- A processing record is either in progress, or finished with a routed action;
-- escalations always carry a reason and completed runs never do.
ALTER TABLE "ReplyProcessing" ADD CONSTRAINT "ReplyProcessing_outcome_check" CHECK (
  ("status" IN ('PROCESSING', 'RETRY') AND "completedAt" IS NULL)
  OR (
    "status" = 'ESCALATED'
    AND "completedAt" IS NOT NULL
    AND "action" IS NOT NULL
    AND "escalationReason" IS NOT NULL
  )
  OR (
    "status" IN ('COMPLETED', 'SKIPPED')
    AND "completedAt" IS NOT NULL
    AND "action" IS NOT NULL
    AND "escalationReason" IS NULL
  )
);

ALTER TABLE "ReplyProcessing" ADD CONSTRAINT "ReplyProcessing_confidence_check" CHECK (
  "confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)
);

ALTER TABLE "ReplyProcessing" ADD CONSTRAINT "ReplyProcessing_attempts_check" CHECK ("attempts" >= 1);
