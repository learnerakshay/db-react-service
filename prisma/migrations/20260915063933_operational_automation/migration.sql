-- CreateEnum
CREATE TYPE "IntegrationEventType" AS ENUM ('BOOKING_CONFIRMED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED');

-- CreateEnum
CREATE TYPE "IntegrationDestination" AS ENUM ('CRM', 'OWNER_NOTIFICATION', 'POST_BOOKING_HANDOFF');

-- CreateEnum
CREATE TYPE "IntegrationDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'RETRY', 'FAILED', 'BLOCKED');

-- AlterEnum
ALTER TYPE "MessagePurpose" ADD VALUE 'CAMPAIGN_STEP_2';

-- AlterEnum
ALTER TYPE "ReplyAction" ADD VALUE 'QUALIFICATION_ANSWER';

-- CreateTable
CREATE TABLE "IntegrationDelivery" (
    "id" UUID NOT NULL,
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "eventType" "IntegrationEventType" NOT NULL,
    "destination" "IntegrationDestination" NOT NULL,
    "campaignLeadId" UUID NOT NULL,
    "bookingOpportunityId" UUID NOT NULL,
    "calendarEventId" UUID,
    "payload" JSONB NOT NULL,
    "status" "IntegrationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMPTZ(3),
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "provider" VARCHAR(32),
    "lastErrorCode" VARCHAR(64),
    "externalReference" VARCHAR(200),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IntegrationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationDelivery_idempotencyKey_key" ON "IntegrationDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "IntegrationDelivery_status_nextAttemptAt_idx" ON "IntegrationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "IntegrationDelivery_bookingOpportunityId_idx" ON "IntegrationDelivery"("bookingOpportunityId");

-- AddForeignKey
ALTER TABLE "IntegrationDelivery" ADD CONSTRAINT "IntegrationDelivery_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationDelivery" ADD CONSTRAINT "IntegrationDelivery_bookingOpportunityId_fkey" FOREIGN KEY ("bookingOpportunityId") REFERENCES "BookingOpportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationDelivery" ADD CONSTRAINT "IntegrationDelivery_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "CalendarWebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (not expressible in schema.prisma).
-- See docs/database.md. Keep these when generating future migrations.
-- One Step 2 per membership is enforced by UNIQUE Message.sendKey; a partial
-- index on the new 'CAMPAIGN_STEP_2' value cannot be created in the same
-- transaction that adds the enum value.
-- ---------------------------------------------------------------------------

ALTER TABLE "IntegrationDelivery" ADD CONSTRAINT "IntegrationDelivery_state_check" CHECK (
  "attempts" >= 0
  AND ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL)
  AND ("status" <> 'PROCESSING' OR ("claimedAt" IS NOT NULL AND "attempts" >= 1))
);
