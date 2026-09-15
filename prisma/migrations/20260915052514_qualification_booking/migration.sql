-- CreateEnum
CREATE TYPE "QualificationFactSource" AS ENUM ('IMPORT', 'OPERATOR', 'CONVERSATION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "QualificationResult" AS ENUM ('PENDING_INFORMATION', 'QUALIFIED', 'NOT_QUALIFIED');

-- CreateEnum
CREATE TYPE "ExtractionOutcome" AS ENUM ('EXTRACTED', 'NOT_REQUIRED', 'INVALID_OUTPUT', 'AI_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('OFFERED', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CalendarEventKind" AS ENUM ('BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED');

-- CreateEnum
CREATE TYPE "CalendarEventOutcome" AS ENUM ('PROCESSED', 'ALREADY_APPLIED', 'UNMATCHED', 'MISMATCH', 'INVALID_STATE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessagePurpose" ADD VALUE 'QUALIFICATION_QUESTION';
ALTER TYPE "MessagePurpose" ADD VALUE 'BOOKING_LINK';

-- CreateTable
CREATE TABLE "QualificationFact" (
    "id" UUID NOT NULL,
    "campaignLeadId" UUID NOT NULL,
    "field" VARCHAR(20) NOT NULL,
    "value" JSONB NOT NULL,
    "source" "QualificationFactSource" NOT NULL,
    "sourceMessageId" UUID,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QualificationFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualificationEvaluation" (
    "id" UUID NOT NULL,
    "campaignLeadId" UUID NOT NULL,
    "inboundMessageId" UUID NOT NULL,
    "result" "QualificationResult" NOT NULL,
    "missingFields" TEXT[],
    "failedRequirements" JSONB NOT NULL,
    "nextField" VARCHAR(20),
    "facts" JSONB NOT NULL,
    "rulesHash" CHAR(64) NOT NULL,
    "rulesSnapshot" JSONB NOT NULL,
    "extraction" "ExtractionOutcome" NOT NULL,
    "discardedFields" TEXT[],
    "aiModel" VARCHAR(100),
    "aiRequestId" VARCHAR(100),
    "errorCode" VARCHAR(64),
    "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualificationEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingOpportunity" (
    "id" UUID NOT NULL,
    "campaignLeadId" UUID NOT NULL,
    "status" "BookingStatus" NOT NULL,
    "calendarProvider" VARCHAR(32) NOT NULL,
    "bookingReference" VARCHAR(64) NOT NULL,
    "bookingUrl" VARCHAR(1000) NOT NULL,
    "linkMessageId" UUID,
    "externalBookingId" VARCHAR(200),
    "appointmentStartAt" TIMESTAMPTZ(3),
    "appointmentEndAt" TIMESTAMPTZ(3),
    "appointmentTimezone" VARCHAR(64),
    "sentAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BookingOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarWebhookEvent" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "eventKey" VARCHAR(240) NOT NULL,
    "kind" "CalendarEventKind" NOT NULL,
    "externalBookingId" VARCHAR(200) NOT NULL,
    "bookingReference" VARCHAR(64),
    "appointmentStartAt" TIMESTAMPTZ(3),
    "appointmentTimezone" VARCHAR(64),
    "outcome" "CalendarEventOutcome" NOT NULL,
    "bookingOpportunityId" UUID,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CalendarWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QualificationFact_campaignLeadId_field_key" ON "QualificationFact"("campaignLeadId", "field");

-- CreateIndex
CREATE UNIQUE INDEX "QualificationEvaluation_inboundMessageId_key" ON "QualificationEvaluation"("inboundMessageId");

-- CreateIndex
CREATE INDEX "QualificationEvaluation_campaignLeadId_evaluatedAt_idx" ON "QualificationEvaluation"("campaignLeadId", "evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingOpportunity_bookingReference_key" ON "BookingOpportunity"("bookingReference");

-- CreateIndex
CREATE UNIQUE INDEX "BookingOpportunity_linkMessageId_key" ON "BookingOpportunity"("linkMessageId");

-- CreateIndex
CREATE INDEX "BookingOpportunity_campaignLeadId_idx" ON "BookingOpportunity"("campaignLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingOpportunity_calendarProvider_externalBookingId_key" ON "BookingOpportunity"("calendarProvider", "externalBookingId");

-- CreateIndex
CREATE INDEX "CalendarWebhookEvent_bookingOpportunityId_idx" ON "CalendarWebhookEvent"("bookingOpportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarWebhookEvent_provider_eventKey_key" ON "CalendarWebhookEvent"("provider", "eventKey");

-- AddForeignKey
ALTER TABLE "QualificationFact" ADD CONSTRAINT "QualificationFact_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualificationEvaluation" ADD CONSTRAINT "QualificationEvaluation_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualificationEvaluation" ADD CONSTRAINT "QualificationEvaluation_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingOpportunity" ADD CONSTRAINT "BookingOpportunity_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingOpportunity" ADD CONSTRAINT "BookingOpportunity_linkMessageId_fkey" FOREIGN KEY ("linkMessageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarWebhookEvent" ADD CONSTRAINT "CalendarWebhookEvent_bookingOpportunityId_fkey" FOREIGN KEY ("bookingOpportunityId") REFERENCES "BookingOpportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (not expressible in schema.prisma).
-- See docs/database.md. Keep these when generating future migrations.
-- ---------------------------------------------------------------------------

-- One active (OFFERED or CONFIRMED) booking opportunity per membership.
CREATE UNIQUE INDEX "BookingOpportunity_active_membership_key"
  ON "BookingOpportunity"("campaignLeadId") WHERE "status" IN ('OFFERED', 'CONFIRMED');

-- A confirmed booking always carries the verified appointment; cancellations
-- keep their history and record when they happened.
ALTER TABLE "BookingOpportunity" ADD CONSTRAINT "BookingOpportunity_state_check" CHECK (
  (
    "status" <> 'CONFIRMED'
    OR (
      "externalBookingId" IS NOT NULL
      AND "appointmentStartAt" IS NOT NULL
      AND "appointmentTimezone" IS NOT NULL
      AND "confirmedAt" IS NOT NULL
    )
  )
  AND ("status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL)
  AND ("appointmentEndAt" IS NULL OR "appointmentEndAt" > "appointmentStartAt")
);

-- Each result carries exactly the detail that explains it.
ALTER TABLE "QualificationEvaluation" ADD CONSTRAINT "QualificationEvaluation_result_check" CHECK (
  (
    "result" = 'PENDING_INFORMATION'
    AND cardinality("missingFields") > 0
    AND "failedRequirements" = '[]'::jsonb
    AND "nextField" IS NOT NULL
  )
  OR (
    "result" = 'QUALIFIED'
    AND cardinality("missingFields") = 0
    AND "failedRequirements" = '[]'::jsonb
    AND "nextField" IS NULL
  )
  OR (
    "result" = 'NOT_QUALIFIED'
    AND "failedRequirements" <> '[]'::jsonb
    AND "nextField" IS NULL
  )
);

-- Facts are scalar values; only conversation facts point at a message.
ALTER TABLE "QualificationFact" ADD CONSTRAINT "QualificationFact_value_check" CHECK (
  jsonb_typeof("value") IN ('string', 'number', 'boolean')
);
ALTER TABLE "QualificationFact" ADD CONSTRAINT "QualificationFact_source_message_check" CHECK (
  "sourceMessageId" IS NULL OR "source" = 'CONVERSATION'
);
