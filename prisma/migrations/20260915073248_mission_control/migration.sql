-- AlterEnum
ALTER TYPE "EscalationReason" ADD VALUE 'HUMAN_TAKEOVER';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "automationPausedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "Message_campaignId_createdAt_idx" ON "Message"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "ReplyProcessing_status_createdAt_idx" ON "ReplyProcessing"("status", "createdAt");
