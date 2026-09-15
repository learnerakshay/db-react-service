# Database

PostgreSQL via Prisma ORM 7 with the `@prisma/adapter-pg` driver adapter.

## Layout

- `prisma/schema.prisma` — models, enums, generator, datasource.
- `prisma/migrations/` — committed SQL migrations (source of truth for the database).
- `prisma.config.ts` — CLI config: schema path, migrations path, `DATABASE_URL`
  (loaded from the root `.env` when present).
- `apps/api/src/generated/prisma/` — generated client (git-ignored, regenerated on `npm install`).
- `apps/api/src/db/client.ts` — the only place a `PrismaClient` is constructed.

## Data model (Phase 1 / Prompt 1)

| Model              | Purpose                                                             | Key constraints                                                                  |
| ------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Lead`             | One global record per contact, identity = E.164 phone               | `phone` UNIQUE; CHECK E.164; CHECK lowercase email; index on `email`             |
| `Campaign`         | Campaign identity, status, config snapshot (JSON, Zod-validated)    | —                                                                                |
| `CampaignLead`     | Campaign membership and campaign-specific lifecycle                 | UNIQUE (`campaignId`, `leadId`); index (`campaignId`, `status`)                  |
| `SuppressionEntry` | Global, permanent do-not-contact list                               | CHECK phone or email present; CHECK formats; **append-only trigger**             |
| `ImportBatch`      | One per import: source, options, counters, status                   | CHECK counters sum to `totalRows`; partial UNIQUE `contentHash` while PROCESSING |
| `ImportRowResult`  | One per source row: outcome, reason, dropped fields, resulting lead | UNIQUE (`importBatchId`, `rowNumber`); CHECK reason matches outcome              |

No raw contact data is kept in import audit rows; operators locate problems by row number.
Conversation/message history is intentionally absent until the phase that owns it.

### States

- `LeadStatus`: `ACTIVE`, `ARCHIVED` (global only).
- `CampaignStatus`: `DRAFT`, `ACTIVE`, `PAUSED`, `COMPLETED`. Only the first three accept new members.
- `CampaignLeadStatus`: `STAGED → QUEUED → STEP_1_SENT → STEP_2_SENT → ENGAGED → QUALIFIED → BOOKED`,
  plus `OPTED_OUT` and `DORMANT_ARCHIVED`. The allowed-transition map and the
  compare-and-set write path live in `modules/campaigns/membership.ts`. Imports only create `STAGED`.

### Hand-written invariants

These live at the end of `20260914065124_data_foundation/migration.sql`. Prisma's
drift detection does not track CHECK constraints, triggers or partial indexes
(`prisma migrate diff` reports no drift), so **review every future generated
migration** to make sure none of them are dropped:

- `Lead_phone_e164_check`, `Lead_email_lowercase_check`
- `SuppressionEntry_identity_check`, `SuppressionEntry_phone_e164_check`, `SuppressionEntry_email_lowercase_check`
- trigger `SuppressionEntry_append_only` (blocks UPDATE and DELETE; TRUNCATE is not blocked)
- `ImportBatch_counts_check`
- partial unique index `ImportBatch_contentHash_processing_key`
- `ImportRowResult_reason_check`
- `DispatchAdmission_capacity_check`, `DispatchAdmission_window_check`
  (in `20260914103226_dispatch_admission/migration.sql`)
- `Message_direction_check`, `Message_provider_id_check`, `Message_body_check`,
  (in `20260914163731_messaging_foundation/migration.sql`)
- partial unique index `Message_outbound_step1_membership_key` (replaces
  `Message_outbound_membership_purpose_key`), `ReplyProcessing_outcome_check`,
  `ReplyProcessing_confidence_check`, `ReplyProcessing_attempts_check`
  (in `20260914172036_reply_intelligence/migration.sql`)
- partial unique index `BookingOpportunity_active_membership_key`,
  `BookingOpportunity_state_check`, `QualificationEvaluation_result_check`,
  `QualificationFact_value_check`, `QualificationFact_source_message_check`
  (in `20260915052514_qualification_booking/migration.sql`)
- `IntegrationDelivery_state_check` (in `*_operational_automation/migration.sql`)
- `ReplyProcessing_review_resolution_check`, partial index
  `ReplyProcessing_open_review_lead_idx`, trigger `OperatorAuditEvent_append_only`
  (blocks UPDATE and DELETE; TRUNCATE is not blocked) (in `*_release_hardening/migration.sql`)

## Ingestion semantics

Pipeline (`modules/imports/ingestion.ts`), shared by every adapter:

```text
adapter row → validate + normalize → dedupe within import → suppression check
            → create or reuse lead → stage into campaign (optional) → record outcome
```

| Outcome      | Reason codes                                                                | Counted as         |
| ------------ | --------------------------------------------------------------------------- | ------------------ |
| `CREATED`    | —                                                                           | accepted, newLeads |
| `EXISTING`   | — (lead with this phone already existed; reused and enriched)               | accepted           |
| `DUPLICATE`  | `DUPLICATE_IN_BATCH` (earlier row in this import had the same phone)        | duplicates         |
| `SUPPRESSED` | `SUPPRESSED_PHONE`, `SUPPRESSED_EMAIL`                                      | suppressed         |
| `INVALID`    | `MALFORMED_ROW`, `MISSING_PHONE`, `INVALID_PHONE`, `PHONE_COUNTRY_REQUIRED` | invalid            |
| `FAILED`     | `PERSISTENCE_ERROR` (chunk transaction rolled back)                         | failed             |

Rules:

- **Identity:** a valid phone is the only required field. National-format numbers
  need an explicit `defaultCountry` on the import; the country is never guessed.
- **Optional fields** (email, names, date, timezone, external ID) that are invalid
  are dropped and listed in `ignoredFields`; they never reject the row.
- **Within an import** the first row for a phone wins; later rows are not merged.
- **Existing leads** are reused. Merge rule: fill fields that are NULL; never
  overwrite a stored value; never change `phone`, `source`, `status` or provenance.
- **Suppression** is checked by phone and by email before any lead is created or
  staged. Suppressed rows create no lead. Imports never modify suppression.
- **Staging** into a campaign skips existing members, non-ACTIVE leads and
  suppressed identities in one SQL statement.
- **Syntax errors** in a CSV reject the upload (HTTP 400) before anything is written.

### Transactions and concurrency

- Rows are written in chunks of 250 per transaction. Leads, memberships, row
  results and batch counters for a chunk commit together, so counters cannot
  drift from row results (also enforced by CHECK).
- A failed chunk rolls back entirely and its rows are recorded as `FAILED`;
  other chunks are unaffected. Deadlock/write-conflict errors (P2034) are retried up to 3 times.
- Concurrent imports of overlapping phones: `INSERT … ON CONFLICT DO NOTHING` on
  the unique phone makes the later transaction wait, then treat the lead as
  existing. Leads are processed in phone order to keep lock ordering consistent.
- The same file (by SHA-256) cannot be imported twice at the same time. A
  PROCESSING batch older than 30 minutes is presumed crashed and marked `FAILED` (`STALE_PROCESSING`).
- Suppression added after a lead is staged is **not** retroactively applied to
  memberships; dispatch must re-check suppression before sending.

## Dispatch admission (Phase 1 / Prompt 2)

Models: `Campaign.statusChangedAt`; `DispatchAdmission` (one row per
`STAGED → QUEUED`, UNIQUE `campaignLeadId`, index `campaignId, admittedAt`);
index `CampaignLead(campaignId, status, createdAt, id)` for the candidate scan.

Campaign lifecycle (`modules/campaigns/lifecycle.ts`):
`DRAFT → ACTIVE`, `ACTIVE ⇄ PAUSED`, `ACTIVE|PAUSED → COMPLETED`. Activation
re-validates the stored config.

Eligibility (`modules/dispatch/eligibility.ts`), first failure wins:

| Check                                   | Reason                     |
| --------------------------------------- | -------------------------- |
| campaign is ACTIVE                      | `CAMPAIGN_NOT_ACTIVE`      |
| membership is STAGED                    | `INVALID_MEMBERSHIP_STATE` |
| phone/email not in SuppressionEntry     | `SUPPRESSED`               |
| lead timezone, else campaign `timezone` | `TIMEZONE_UNAVAILABLE`     |
| local time in `[start, end)`            | `OUTSIDE_SEND_WINDOW`      |
| rolling-hour capacity left              | `HOURLY_LIMIT_REACHED`     |

Timezones are IANA names evaluated with the runtime ICU database (DST-aware).
Campaign `timezone: null` means no fallback. Timezones are never inferred.

Admission transaction (`modules/dispatch/admission.ts`):

1. `SELECT … FROM "Campaign" … FOR UPDATE` — serializes runs per campaign;
   pause/complete wait for a running admission and vice versa.
2. Return unless ACTIVE.
3. `LOCK TABLE "SuppressionEntry" IN SHARE MODE` — suppression inserts wait
   until the admission commits, so the check cannot go stale mid-transaction.
4. Count `DispatchAdmission` rows with `admittedAt > now − 1 hour`.
5. Scan STAGED members oldest first (keyset pages, bounded by `scanLimit`),
   admit via `transitionCampaignLead` + `DispatchAdmission`, move suppressed
   members to `OPTED_OUT`, stop when capacity is used.

The reference time is the database transaction timestamp, so all workers share
one clock. Counters are rows in PostgreSQL; restarts change nothing.

Scheduler: pg-boss cron `campaign-scheduler-tick` every minute enqueues one
`campaign-admission` job per ACTIVE campaign (key = campaign id, queue policy
`stately`). Retries are bounded (3, exponential backoff).

## Messaging (Phase 2 / Prompt 1)

Models:

- `Message` — one row per SMS, either direction. Outbound: `sendKey`
  (`<campaignLeadId>:CAMPAIGN_STEP_1`, UNIQUE), `status`
  `PENDING → SENDING → ACCEPTED → SENT → DELIVERED`, or `FAILED`, `UNCERTAIN`,
  `CANCELLED`. Inbound: `RECEIVED` with `inboundResolution`
  (`MATCHED | AMBIGUOUS_CAMPAIGN | NO_CAMPAIGN | UNKNOWN_SENDER`) and optional
  `safetyAction = HARD_OPT_OUT`. UNIQUE (`provider`, `providerMessageId`).
- `ProviderWebhookEvent` — UNIQUE (`provider`, `eventKey`); stores identifiers,
  provider status, error code and outcome only (no raw payloads).
- Index `CampaignLead(status, statusChangedAt)` for the dispatch scan.

Outbound Step 1 (`modules/messaging/outbound.ts`):

1. **Prepare** (transaction): `SELECT … FOR UPDATE OF CampaignLead FOR SHARE OF Campaign`.
   Existing logical send that is not `PENDING` → report it, never send again
   (a `SENDING` row older than 10 minutes becomes `UNCERTAIN`). Then require
   membership `QUEUED`, campaign `ACTIVE`, a Step 1 template, and recipient
   inside the send window. `LOCK TABLE "SuppressionEntry" IN SHARE MODE` and
   check suppression by phone and email: suppressed → `CANCELLED` +
   `QUEUED → OPTED_OUT`. Render the template, write the Message as `SENDING`.
2. **Provider call** outside any transaction (15s timeout, no SDK auto-retry).
3. **Record** (transaction): `ACCEPTED` → Message `ACCEPTED` + `QUEUED → STEP_1_SENT`;
   definite rejection → `FAILED` (Twilio 21610 also adds global suppression and
   opts the membership out); retryable rejection (429, request never sent) →
   back to `PENDING`; anything else → `UNCERTAIN`, never resent.

Dispatch: pg-boss cron `outbound-dispatch-tick` (every minute) marks stale
`SENDING` rows `UNCERTAIN` and enqueues `outbound-step1-send` per candidate
(QUEUED, ACTIVE campaign, template, in window, no non-`PENDING` send; key =
membership id).

Inbound (`modules/messaging/inbound.ts`), one transaction per webhook: insert
event (duplicate → no-op), resolve lead by E.164 phone and campaign by outbound
messages sent to that lead from the receiving number, insert Message, and for an
exact hard opt-out command create suppression (unless one exists) and move
every membership that can opt out to `OPTED_OUT`.

Delivery (`modules/messaging/delivery.ts`): insert event keyed
`status:<sid>:<providerStatus>` (duplicate → no-op); update the Message only
forward (`ACCEPTED → SENT → DELIVERED | FAILED`; DELIVERED/FAILED final).

## Reply intelligence (Phase 2 / Prompt 2)

Models:

- `ReplyProcessing` — one row per inbound message (UNIQUE `inboundMessageId`):
  status (`PROCESSING | RETRY | COMPLETED | ESCALATED | SKIPPED`), claim
  `attempts` + `claimedAt`, validated `classification`/`confidence`/extracted
  details, routed `action`, `escalationReason`, cited `knowledgeItemIds`, AI
  provider/model/request ids, `replyMessageId`. No model reasoning is stored.
- `KnowledgeItem` — operator-approved facts (campaign-specific or business-wide),
  category, optional question, content, keywords, `active`.
- `MessagePurpose.CONVERSATIONAL_REPLY` — replies with sendKey
  `<inboundMessageId>:CONVERSATIONAL_REPLY`.

Processing (`modules/replies/processor.ts`):

1. **Claim** (transaction): insert the processing row (ON CONFLICT DO NOTHING)
   and lock it. Finished → no-op (an unsent reply is resumed); live claim → stop;
   stale claim (5 min) or RETRY → re-claim with `attempts + 1`; after 3 attempts →
   ESCALATED `AI_UNAVAILABLE`.
2. **Decide** (no transaction): exact STOP already handled → SKIPPED (no AI);
   inbound older than 24h → ESCALATED; suppressed lead → ESCALATED (no AI).
   Otherwise classify with ≤10 prior messages of the same membership, validate,
   route. Questions: retrieve facts; none → ESCALATED `MISSING_KNOWLEDGE`
   (+ handoff text if configured); otherwise grounded answer, validated; failure
   → ESCALATED `UNGROUNDED_ANSWER`.
3. **Apply** (transaction, only for the latest claim attempt): suppression +
   `OPTED_OUT` for opt-outs (and cancel PENDING outbound), `STEP_1_SENT → ENGAGED`,
   `→ DORMANT_ARCHIVED` for declines, reply Message as PENDING, processing result.
4. **Send** the reply via `sendConversationalReply` (lock, suppression re-check,
   SENDING claim, provider, record; UNCERTAIN never resent).

Routing (`modules/replies/router.ts`): below threshold → HUMAN_REVIEW; confident
HARD_OPT_OUT → OPT_OUT (lead-level, even without campaign context); non-MATCHED
association, closed conversation or pending human review → HUMAN_REVIEW;
POSITIVE → ENGAGE + positive text; QUESTION → grounded answer; NOT_INTERESTED →
close + decline text; AMBIGUOUS → clarify text once, then HUMAN_REVIEW. A missing
reply text escalates instead of improvising.

Jobs: `reply-process` is enqueued by the inbound webhook; `reply-processing-tick`
(every minute) re-enqueues unprocessed/RETRY/stale inbound messages and PENDING
replies (`reply-send`).

Permanent Step 1 failures: a non-retryable provider rejection or an unrenderable
template moves the membership `QUEUED → DORMANT_ARCHIVED`; the outbound dispatch
tick archives any members still stuck that way. UNCERTAIN and retryable PENDING
sends are never archived.

## Qualification + booking (Phase 3 / Prompt 1)

Models:

- `QualificationFact` — current value per membership and configured field
  (UNIQUE `campaignLeadId, field`), `source` (`OPERATOR` > `IMPORT` = `SYSTEM` >
  `CONVERSATION`), `observedAt`, `sourceMessageId`. Lower precedence never
  overwrites higher; equal precedence only moves forward in `observedAt`.
- `QualificationEvaluation` — one per triggering inbound message (UNIQUE
  `inboundMessageId`): `result`, `missingFields`, `failedRequirements`,
  `nextField`, facts used, `rulesHash` + `rulesSnapshot`, extraction outcome,
  discarded fields, AI model/request id. No model reasoning.
- `BookingOpportunity` — `OFFERED → CONFIRMED → CANCELLED` (or `EXPIRED`),
  unguessable `bookingReference` (UNIQUE) placed on the link, `bookingUrl`,
  `linkMessageId` (UNIQUE), external booking id (UNIQUE per `calendarProvider`),
  appointment start/end/timezone, `sentAt`, `confirmedAt`, `cancelledAt`.
  At most one OFFERED/CONFIRMED row per membership (partial unique index).
- `CalendarWebhookEvent` — UNIQUE (`provider`, `eventKey = <kind>:<eventId>`),
  outcome (`PROCESSED | ALREADY_APPLIED | UNMATCHED | MISMATCH | INVALID_STATE`),
  booking id, reference and appointment timing; the booking audit trail.
- `MessagePurpose.QUALIFICATION_QUESTION` (sendKey
  `<campaignLeadId>:QUALIFICATION_QUESTION:<field>`, one per field) and
  `BOOKING_LINK` (sendKey `<opportunityId>:BOOKING_LINK`).
- `CampaignLeadStatus` edge `BOOKED → QUALIFIED` (verified cancellation).

Qualification (`modules/conversion/qualification.ts`), per inbound message:

1. **Eligible** (no AI): membership `ENGAGED`, campaign has `qualification`
   rules, reply processing `COMPLETED` with `ENGAGE | ANSWER_QUESTION | CLARIFY`
   (escalated conversations belong to a human), inbound ≤ 24h old, lead not suppressed.
2. **Extract**: only fields not known from a higher-precedence source; strict
   Zod schema (no extra keys); each value needs evidence copied from the lead's
   messages (numbers must appear in it), otherwise discarded. Invalid output /
   final AI failure → evaluation recorded with existing facts.
3. **Apply** (transaction, `CampaignLead FOR UPDATE`): write facts, run
   `evaluateQualification`, insert the evaluation, then
   `PENDING_INFORMATION` → PENDING question for `nextField` (if configured, once per field);
   `NOT_QUALIFIED` → `ENGAGED → DORMANT_ARCHIVED`;
   `QUALIFIED` → `ENGAGED → QUALIFIED` + opportunity + PENDING booking-link message.
4. **Send** via `sendConversionMessage` (lock message + membership, expected
   state, suppression re-check under SHARE lock, SENDING claim; UNCERTAIN never resent).

Booking events (`modules/conversion/booking-events.ts`), one transaction per
verified event: insert event (duplicate → no-op); resolve the opportunity by
reference and/or provider booking id (disagreement → `MISMATCH`); lock
membership then opportunity; provider and invitee identity must match. Created
(`OFFERED` + `QUALIFIED`) → `CONFIRMED` + `QUALIFIED → BOOKED`; rescheduled →
same row updated; cancelled → `CANCELLED` (row kept) + `BOOKED → QUALIFIED`.
No automatic re-offer after cancellation (one automatic offer per membership).

Jobs: `conversion-tick` (every minute) enqueues `qualification-process` per
eligible inbound message and `conversion-send` per PENDING question/link older than 60s.

## Operational automation (Phase 3 / Prompt 2)

Models / values:

- `MessagePurpose.CAMPAIGN_STEP_2` — sendKey `<campaignLeadId>:CAMPAIGN_STEP_2` (one per membership).
- `ReplyAction.QUALIFICATION_ANSWER` — reply routed to qualification; no generic reply sent.
- `IntegrationDelivery` — outbox row per logical external action: UNIQUE
  `idempotencyKey` (`<opportunityId|calendarEventId>:<eventType>:<destination>`),
  `eventType` (`BOOKING_CONFIRMED | BOOKING_RESCHEDULED | BOOKING_CANCELLED`),
  `destination` (`CRM | OWNER_NOTIFICATION | POST_BOOKING_HANDOFF`), payload
  snapshot, `status` (`PENDING | PROCESSING | COMPLETED | RETRY | FAILED | BLOCKED`),
  `attempts`, `claimedAt`, `nextAttemptAt`, `provider`, `lastErrorCode`,
  `externalReference`, `completedAt`. Index (`status`, `nextAttemptAt`).

Step 2 (`modules/followup/step2.ts`), like Step 1: lock membership, existing
send → report; require STEP_1_SENT, ACTIVE campaign, `messages.step2`, Step 1
accepted ≥ `followUpDelayHours` ago, no inbound from the lead since Step 1, no
ESCALATED processing, send window; suppression under SHARE lock; claim SENDING;
provider; ACCEPTED → `STEP_2_SENT`, retryable → PENDING, unknown → UNCERTAIN
(never resent), permanent → FAILED + `DORMANT_ARCHIVED` (or OPTED_OUT for a
provider opt-out).

Archival (`modules/followup/archival.ts`): STEP_2_SENT (or STEP_1_SENT with an
UNCERTAIN Step 2) whose Step 2 claim is ≥ `archiveDelayDays` old, no inbound
from the lead since, no ESCALATED processing, no booking opportunity →
`DORMANT_ARCHIVED`, re-checked under `FOR UPDATE`. Nothing is deleted.

Booking outbox: `applyBookingEvent` writes deliveries in the same transaction
when an event is PROCESSED — confirmed → CRM + owner + handoff (key per
opportunity); rescheduled → owner + handoff (key per calendar event; no CRM,
no second conversion); cancelled → CRM + owner + handoff (key per opportunity).

Delivery (`modules/integrations/deliveries.ts`): claim under `FOR UPDATE`
(final → no-op; live PROCESSING → stop; not due → stop; no provider → BLOCKED
`NOT_CONFIGURED`; attempts exhausted → FAILED); provider call with the
idempotency key outside the transaction; record for this attempt only:
COMPLETED, RETRY (backoff 60s × 2^(attempt−1)), or FAILED after 5 attempts / permanent.

Job: `operations-tick` (every minute): enqueue `outbound-step2-send` per
candidate (key = membership), run the archival pass, enqueue
`integration-delivery` per due delivery (key = delivery id).

## Mission Control (Phase 4 / Prompt 1)

Migration `*_mission_control` (no hand-written invariants added):

- `Lead.automationPausedAt` (nullable `timestamptz`): operator human takeover.
  Written only by `setHumanTakeover` (`modules/leads/takeover.ts`); read under
  `FOR SHARE` by every automated send path. See `docs/mission-control.md`.
- `EscalationReason.HUMAN_TAKEOVER`: inbound message received while a human owns
  the conversation.
- Index `ReplyProcessing (status, createdAt)`: review queue, newest first.
- Index `Message (campaignId, createdAt)`: campaign activity and last-activity lookups.

## Release hardening (Phase 4 / Prompt 2)

Migration `*_release_hardening`:

- `ReplyProcessing.reviewResolvedAt`, `reviewResolution` (`ReviewResolution`),
  `reviewResolvedBy`, `reviewNote`: human review resolution. Open review =
  `status = ESCALATED AND reviewResolvedAt IS NULL`. Written only by
  `modules/reviews/resolution.ts`.
- `OperatorAuditEvent`: append-only operator audit (`OperatorAction`,
  `AuditTargetType`), indexes on `createdAt` and `(targetType, targetId, createdAt)`.
- Hand-written: `ReplyProcessing_review_resolution_check` (resolution only on
  escalated rows, recorded completely or not at all), partial index
  `ReplyProcessing_open_review_lead_idx`, trigger `OperatorAuditEvent_append_only`.
- `CampaignLead` transition map: `ENGAGED → BOOKED` removed; `QUALIFIED → BOOKED`
  is the only booking conversion (application map, no schema change).

## Migration workflow

| Situation                            | Command                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| Change schema during development     | `npm run db:migrate` (`prisma migrate dev --name <change>`) |
| Regenerate client only               | `npm run db:generate`                                       |
| Apply committed migrations (CI/prod) | `npm run db:deploy`                                         |
| Inspect state                        | `npm run db:status`                                         |

Rules:

- Every schema change ships as a committed migration in `prisma/migrations/`.
- Never edit an applied migration; add a new one.
- Never use `prisma db push` against shared or production databases.
- Production applies migrations with `db:deploy` before the new API version starts.

## Local development database

Without Docker or a system PostgreSQL:

```bash
npm run db:local
```

Starts a real PostgreSQL (embedded-postgres binaries) on `localhost:54329` with
data in `.local/postgres` (git-ignored) and database `cadentor_dev`. Put the
printed connection string in `.env` as `DATABASE_URL` (password from
`LOCAL_DB_PASSWORD`, default `postgres`). Local development only.

## Connectivity

`GET /ready` runs `SELECT 1` through the Prisma client (5s connection timeout):

- `200 {"status":"ready","checks":{"database":"up"}}`
- `503` with `"down"` (unreachable) or `"not_configured"` (no `DATABASE_URL`)

## Test database strategy

- `npm run test` (API) starts a throwaway embedded PostgreSQL in a temp
  directory, applies all migrations with `prisma migrate deploy`, and removes it afterwards.
- CI or developers with a server can set `TEST_DATABASE_URL`; its database name
  must contain `test`, because tests truncate every table.
- Test files run sequentially and truncate tables before each test.
- Constraint, race and transaction tests always use the real database, never mocks.
