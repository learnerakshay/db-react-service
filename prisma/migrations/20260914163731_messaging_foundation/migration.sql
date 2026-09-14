-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('SMS');

-- CreateEnum
CREATE TYPE "MessagePurpose" AS ENUM ('CAMPAIGN_STEP_1', 'INBOUND_REPLY');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'FAILED', 'UNCERTAIN', 'CANCELLED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "InboundResolution" AS ENUM ('MATCHED', 'AMBIGUOUS_CAMPAIGN', 'NO_CAMPAIGN', 'UNKNOWN_SENDER');

-- CreateEnum
CREATE TYPE "SafetyAction" AS ENUM ('HARD_OPT_OUT');

-- CreateEnum
CREATE TYPE "WebhookEventKind" AS ENUM ('INBOUND_MESSAGE', 'DELIVERY_STATUS');

-- CreateEnum
CREATE TYPE "WebhookEventOutcome" AS ENUM ('PROCESSED', 'STALE', 'UNKNOWN_MESSAGE', 'IGNORED');

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "channel" "MessageChannel" NOT NULL DEFAULT 'SMS',
    "purpose" "MessagePurpose" NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "providerMessageId" VARCHAR(64),
    "leadId" UUID,
    "campaignId" UUID,
    "campaignLeadId" UUID,
    "fromNumber" VARCHAR(32) NOT NULL,
    "toNumber" VARCHAR(32) NOT NULL,
    "body" VARCHAR(1600),
    "sendKey" VARCHAR(80),
    "inboundResolution" "InboundResolution",
    "safetyAction" "SafetyAction",
    "errorCode" VARCHAR(64),
    "sendingStartedAt" TIMESTAMPTZ(3),
    "acceptedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderWebhookEvent" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "eventKey" VARCHAR(160) NOT NULL,
    "kind" "WebhookEventKind" NOT NULL,
    "providerMessageId" VARCHAR(64) NOT NULL,
    "providerStatus" VARCHAR(32),
    "errorCode" VARCHAR(64),
    "outcome" "WebhookEventOutcome" NOT NULL,
    "messageId" UUID,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProviderWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Message_sendKey_key" ON "Message"("sendKey");

-- CreateIndex
CREATE INDEX "Message_leadId_createdAt_idx" ON "Message"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_campaignLeadId_idx" ON "Message"("campaignLeadId");

-- CreateIndex
CREATE INDEX "Message_status_sendingStartedAt_idx" ON "Message"("status", "sendingStartedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_provider_providerMessageId_key" ON "Message"("provider", "providerMessageId");

-- CreateIndex
CREATE INDEX "ProviderWebhookEvent_messageId_idx" ON "ProviderWebhookEvent"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderWebhookEvent_provider_eventKey_key" ON "ProviderWebhookEvent"("provider", "eventKey");

-- CreateIndex
CREATE INDEX "CampaignLead_status_statusChangedAt_idx" ON "CampaignLead"("status", "statusChangedAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignLeadId_fkey" FOREIGN KEY ("campaignLeadId") REFERENCES "CampaignLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderWebhookEvent" ADD CONSTRAINT "ProviderWebhookEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (not expressible in schema.prisma).
-- See docs/database.md. Keep these when generating future migrations.
-- ---------------------------------------------------------------------------

-- Outbound and inbound rows each carry exactly the fields their direction needs.
ALTER TABLE "Message" ADD CONSTRAINT "Message_direction_check" CHECK (
  (
    "direction" = 'OUTBOUND'
    AND "status" <> 'RECEIVED'
    AND "sendKey" IS NOT NULL
    AND "leadId" IS NOT NULL
    AND "campaignLeadId" IS NOT NULL
    AND "inboundResolution" IS NULL
    AND "safetyAction" IS NULL
    AND "toNumber" ~ '^\+[1-9][0-9]{6,14}$'
  )
  OR (
    "direction" = 'INBOUND'
    AND "status" = 'RECEIVED'
    AND "sendKey" IS NULL
    AND "providerMessageId" IS NOT NULL
    AND "inboundResolution" IS NOT NULL
    AND "receivedAt" IS NOT NULL
  )
);

-- A message counts as accepted/sent/delivered only with the provider's id.
ALTER TABLE "Message" ADD CONSTRAINT "Message_provider_id_check" CHECK (
  "status" NOT IN ('ACCEPTED', 'SENT', 'DELIVERED') OR "providerMessageId" IS NOT NULL
);

-- Body may be absent only for an outbound send cancelled before rendering.
ALTER TABLE "Message" ADD CONSTRAINT "Message_body_check" CHECK (
  "body" IS NOT NULL OR ("direction" = 'OUTBOUND' AND "status" = 'CANCELLED')
);

-- Defense in depth for "one logical send per membership and purpose".
CREATE UNIQUE INDEX "Message_outbound_membership_purpose_key"
  ON "Message"("campaignLeadId", "purpose") WHERE "direction" = 'OUTBOUND';
