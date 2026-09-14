-- CreateEnum
CREATE TYPE "TimezoneSource" AS ENUM ('LEAD', 'CAMPAIGN');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "DispatchAdmission" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "campaignLeadId" UUID NOT NULL,
    "admittedAt" TIMESTAMPTZ(3) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "timezoneSource" "TimezoneSource" NOT NULL,
    "localTime" CHAR(5) NOT NULL,
    "sendWindowStart" CHAR(5) NOT NULL,
    "sendWindowEnd" CHAR(5) NOT NULL,
    "hourlyLimit" INTEGER NOT NULL,
    "priorAdmissionsInHour" INTEGER NOT NULL,
    "jobId" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchAdmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DispatchAdmission_campaignLeadId_key" ON "DispatchAdmission"("campaignLeadId");

-- CreateIndex
CREATE INDEX "DispatchAdmission_campaignId_admittedAt_idx" ON "DispatchAdmission"("campaignId", "admittedAt");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "CampaignLead_campaignId_status_createdAt_id_idx" ON "CampaignLead"("campaignId", "status", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "DispatchAdmission" ADD CONSTRAINT "DispatchAdmission_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchAdmission" ADD CONSTRAINT "DispatchAdmission_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (not expressible in schema.prisma).
-- See docs/database.md. Keep these when generating future migrations.
-- ---------------------------------------------------------------------------

-- An admission can never record a decision that exceeded its own capacity view.
ALTER TABLE "DispatchAdmission" ADD CONSTRAINT "DispatchAdmission_capacity_check" CHECK (
  "hourlyLimit" > 0 AND "priorAdmissionsInHour" >= 0 AND "priorAdmissionsInHour" < "hourlyLimit"
);

-- An admission can never record a recipient local time outside its send window.
ALTER TABLE "DispatchAdmission" ADD CONSTRAINT "DispatchAdmission_window_check" CHECK (
  "localTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
  "sendWindowStart" < "sendWindowEnd" AND
  "localTime" >= "sendWindowStart" AND "localTime" < "sendWindowEnd"
);
