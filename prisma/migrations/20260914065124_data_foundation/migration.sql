-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CampaignLeadStatus" AS ENUM ('STAGED', 'QUEUED', 'STEP_1_SENT', 'STEP_2_SENT', 'ENGAGED', 'QUALIFIED', 'BOOKED', 'OPTED_OUT', 'DORMANT_ARCHIVED');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('OPT_OUT', 'DO_NOT_CONTACT', 'COMPLAINT', 'LEGAL', 'INVALID_CONTACT');

-- CreateEnum
CREATE TYPE "SuppressionSource" AS ENUM ('IMPORT', 'OPERATOR', 'INBOUND_MESSAGE', 'PROVIDER');

-- CreateEnum
CREATE TYPE "ImportSourceType" AS ENUM ('CSV');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowOutcome" AS ENUM ('CREATED', 'EXISTING', 'DUPLICATE', 'SUPPRESSED', 'INVALID', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowReason" AS ENUM ('MALFORMED_ROW', 'MISSING_PHONE', 'INVALID_PHONE', 'PHONE_COUNTRY_REQUIRED', 'DUPLICATE_IN_BATCH', 'SUPPRESSED_PHONE', 'SUPPRESSED_EMAIL', 'PERSISTENCE_ERROR');

-- CreateTable
CREATE TABLE "Lead" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(16) NOT NULL,
    "email" VARCHAR(254),
    "firstName" VARCHAR(100),
    "lastName" VARCHAR(100),
    "source" VARCHAR(200) NOT NULL,
    "externalId" VARCHAR(200),
    "lastServiceAt" DATE,
    "timezone" VARCHAR(64),
    "status" "LeadStatus" NOT NULL DEFAULT 'ACTIVE',
    "firstImportBatchId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLead" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "status" "CampaignLeadStatus" NOT NULL DEFAULT 'STAGED',
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importBatchId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CampaignLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(16),
    "email" VARCHAR(254),
    "reason" "SuppressionReason" NOT NULL,
    "source" "SuppressionSource" NOT NULL,
    "reference" VARCHAR(200),
    "note" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" UUID NOT NULL,
    "sourceType" "ImportSourceType" NOT NULL,
    "sourceReference" VARCHAR(255),
    "sourceLabel" VARCHAR(200) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "defaultCountry" CHAR(2),
    "campaignId" UUID,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PROCESSING',
    "errorCode" VARCHAR(64),
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "newLeadCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "stagedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRowResult" (
    "id" UUID NOT NULL,
    "importBatchId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "outcome" "ImportRowOutcome" NOT NULL,
    "reason" "ImportRowReason",
    "ignoredFields" TEXT[],
    "leadId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRowResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_phone_key" ON "Lead"("phone");

-- CreateIndex
CREATE INDEX "Lead_email_idx" ON "Lead"("email");

-- CreateIndex
CREATE INDEX "CampaignLead_campaignId_status_idx" ON "CampaignLead"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignLead_leadId_idx" ON "CampaignLead"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignLead_campaignId_leadId_key" ON "CampaignLead"("campaignId", "leadId");

-- CreateIndex
CREATE INDEX "SuppressionEntry_phone_idx" ON "SuppressionEntry"("phone");

-- CreateIndex
CREATE INDEX "SuppressionEntry_email_idx" ON "SuppressionEntry"("email");

-- CreateIndex
CREATE INDEX "ImportBatch_startedAt_idx" ON "ImportBatch"("startedAt");

-- CreateIndex
CREATE INDEX "ImportRowResult_importBatchId_outcome_idx" ON "ImportRowResult"("importBatchId", "outcome");

-- CreateIndex
CREATE INDEX "ImportRowResult_leadId_idx" ON "ImportRowResult"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRowResult_importBatchId_rowNumber_key" ON "ImportRowResult"("importBatchId", "rowNumber");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_firstImportBatchId_fkey" FOREIGN KEY ("firstImportBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRowResult" ADD CONSTRAINT "ImportRowResult_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRowResult" ADD CONSTRAINT "ImportRowResult_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (not expressible in schema.prisma).
-- See docs/database.md. Keep these when generating future migrations.
-- ---------------------------------------------------------------------------

-- Canonical identity formats: E.164 phone, lowercase email.
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_phone_e164_check" CHECK ("phone" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_email_lowercase_check" CHECK ("email" IS NULL OR "email" = lower("email"));

ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_identity_check" CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL);
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_phone_e164_check" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_email_lowercase_check" CHECK ("email" IS NULL OR "email" = lower("email"));

-- Suppression is permanent: entries can be added, never changed or removed.
CREATE FUNCTION "suppression_entry_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SuppressionEntry is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "SuppressionEntry_append_only"
BEFORE UPDATE OR DELETE ON "SuppressionEntry"
FOR EACH ROW EXECUTE FUNCTION "suppression_entry_append_only"();

-- Import counters can never drift from each other.
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_counts_check" CHECK (
  "acceptedCount" >= 0 AND "newLeadCount" >= 0 AND "duplicateCount" >= 0 AND
  "suppressedCount" >= 0 AND "invalidCount" >= 0 AND "failedCount" >= 0 AND "stagedCount" >= 0 AND
  "newLeadCount" <= "acceptedCount" AND
  "totalRows" = "acceptedCount" + "duplicateCount" + "suppressedCount" + "invalidCount" + "failedCount"
);

-- The same content cannot be imported twice at the same time.
CREATE UNIQUE INDEX "ImportBatch_contentHash_processing_key" ON "ImportBatch"("contentHash") WHERE "status" = 'PROCESSING';

-- A row result's reason must match its outcome.
ALTER TABLE "ImportRowResult" ADD CONSTRAINT "ImportRowResult_reason_check" CHECK (
  ("outcome" IN ('CREATED', 'EXISTING') AND "reason" IS NULL AND "leadId" IS NOT NULL) OR
  ("outcome" = 'DUPLICATE' AND "reason" = 'DUPLICATE_IN_BATCH') OR
  ("outcome" = 'SUPPRESSED' AND "reason" IN ('SUPPRESSED_PHONE', 'SUPPRESSED_EMAIL')) OR
  ("outcome" = 'INVALID' AND "reason" IN ('MALFORMED_ROW', 'MISSING_PHONE', 'INVALID_PHONE', 'PHONE_COUNTRY_REQUIRED')) OR
  ("outcome" = 'FAILED' AND "reason" = 'PERSISTENCE_ERROR')
);
