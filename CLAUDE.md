# CLAUDE.md — Cadentor Service 4

## Project identity

**Cadentor — Service 4: Dormant Lead & Database Reactivation Engine**

Ingests historical, never-converted leads; cleans and validates them; suppresses
prohibited contacts; re-engages eligible leads through rate-controlled messaging;
interprets replies; answers grounded questions; qualifies; books; syncs to CRM;
notifies the owner; and reports everything with an audit trail.

This file governs all Claude Code work in this repository. Read it before every task.

## Phase registry

| Phase                                                                 | Status                       |
| --------------------------------------------------------------------- | ---------------------------- |
| PHASE 0 — Foundation                                                  | COMPLETE / VERIFIED / FROZEN |
| PHASE 1 / Prompt 1 — Data Foundation + Ingestion                      | COMPLETE / VERIFIED / FROZEN |
| PHASE 1 / Prompt 2 — Campaign Queue, Throttling, Dispatch Eligibility | COMPLETE / VERIFIED / FROZEN |
| PHASE 2 / Prompt 1 — Messaging + Webhook Foundation                   | COMPLETE / VERIFIED / FROZEN |
| PHASE 2 / Prompt 2 — Intent Classification + Grounded Reply Engine    | COMPLETE / VERIFIED / FROZEN |
| PHASE 3 / Prompt 1 — Qualification + Booking Conversion Engine        | COMPLETE / VERIFIED / FROZEN |
| PHASE 3 / Prompt 2 — CRM Sync + Owner Notifications + Follow-up       | COMPLETE / VERIFIED / FROZEN |
| PHASE 4 / Prompt 1 — Mission Control Dashboard                        | COMPLETE / VERIFIED / FROZEN |
| PHASE 4 / Prompt 2 — Final Hardening + Review Resolution + Release    | COMPLETE / VERIFIED / FROZEN |
| ENVIRONMENT VERIFICATION                                              | NOT STARTED                  |
| DEMO / PROOF                                                          | NOT STARTED                  |
| CLIENT DEPLOYMENT                                                     | NOT STARTED                  |

Only the phase explicitly authorized by the user is active. Update this table
only when the user confirms a status change.

## Scope discipline

- Modify only what the active phase requires.
- No unrelated refactors, renames, reformatting or "while I'm here" cleanups.
- Inspect existing code before changing it; extend existing patterns rather than
  introducing parallel ones.
- Preserve frozen modules (see Freeze policy).
- **Never begin a later phase early.** Interfaces for later phases may exist as
  provisional contracts; implementations may not.
- If the active phase genuinely needs a change to frozen work, stop and explain
  the defect to the user first.

## Architecture rules

```text
apps/web  ──HTTP──▶  apps/api routes (Express only here)
                          │ calls
                          ▼
                    modules/<capability>   (domain + application services)
                     │        │        │
                     ▼        ▼        ▼
                   db/     providers/   jobs/
                 (Prisma)  (interfaces) (JobQueue interface)
                             │
                             ▼
                       adapters ──▶ external services
```

- **Express stays at the edge.** `req`/`res` never enter `modules/`. Routes parse
  and validate input, call a service, and shape the response.
- **Database state is authoritative.** External systems (CRM, calendar, SMS
  provider) are mirrors or channels, never the source of truth.
- **Side effects go through explicit services.** Sending, booking, syncing and
  notifying each have exactly one service entry point.
- **LLMs never execute side effects.** AI output is schema-validated data
  (classification, extraction, summary, draft). A deterministic router decides
  what happens.
- **Configuration, not magic values.** `process.env` is read only in
  `apps/api/src/server.ts` → `loadConfig()`; web reads `import.meta.env` only in
  `apps/web/src/lib/config.ts`. Operational numbers (limits, windows, delays,
  thresholds) live in `AppConfig`.
- **Shared code is contracts only.** `packages/shared` holds API DTOs, enums and
  response shapes used by both apps. No Prisma types, no backend internals.
- **One Prisma client per process**, created in `server.ts` via `db/client.ts`.
- Future feature routes mount under `/api/v1`. `/health` and `/ready` stay at root.

## TypeScript policy

- `strict` mode plus `noUncheckedIndexedAccess`; do not loosen compiler options.
- No `any`. Use `unknown` and narrow. No non-null assertions to silence errors.
- Explicit types on exported functions and public contracts.
- Model finite states as string-literal unions; switch exhaustively (`never` check).
- Runtime-validate every trust boundary with Zod: HTTP input, webhooks, env,
  provider responses, AI output, imported files.
- ESM with `.js` import suffixes in the API (NodeNext).

## State policy

- Lifecycle status changes (lead, campaign, message, conversation, booking)
  happen **only** inside the owning module's service functions, which validate
  the transition against an explicit allowed-transition map.
- `CampaignLead.status` changes only through `transitionCampaignLead`
  (`apps/api/src/modules/campaigns/membership.ts`); new edges need tests.
- `Campaign.status` changes only through `applyCampaignAction`
  (`apps/api/src/modules/campaigns/lifecycle.ts`).
- `STAGED → QUEUED` happens only in `admitEligibleMembers`
  (`apps/api/src/modules/dispatch/admission.ts`), which applies
  `evaluateDispatchEligibility` — the single eligibility rule. `QUEUED` means
  approved for sending, never that anything was sent; `STEP_1_SENT` is set only
  after a provider accepts a message (Phase 2).
- Business logic takes the reference time as a parameter; do not call
  `new Date()` inside eligibility or capacity decisions.
- Suppression is global and append-only (DB trigger). Anything that sends must
  re-check suppression immediately before the send, not rely on staging-time checks.
- Hand-written SQL invariants (CHECKs, partial unique index, trigger) are not
  tracked by Prisma drift detection; review every generated migration so none
  are dropped (see `docs/database.md`).
- Never write `status = ...` ad hoc in routes, jobs, adapters or scripts.
- Transitions that trigger side effects record an audit entry.

## Provider policy

```text
Domain/Application Logic
        ↓
Provider Interface      apps/api/src/providers/<kind>/index.ts
        ↓
Provider Adapter        apps/api/src/providers/<kind>/<vendor>.ts
        ↓
External Service
```

- Vendor SDKs are imported only in adapter files.
- Adapters convert vendor failures to `ProviderError` and never leak vendor types.
- Every side-effecting provider call carries an idempotency key.
- Provider interfaces in Phase 0 are provisional; the owning phase finalizes them.
- Messaging is final (Phase 2 / Prompt 1): `providers/messaging/index.ts` is the
  contract, `twilio.ts` the only adapter (the only file importing `twilio`),
  `registry.ts` builds it from config.

## Messaging safety rules

- Every provider send goes through `sendStep1Message` (or a later sibling built
  the same way): lock the membership, re-check campaign ACTIVE, membership
  status, send window and **global suppression immediately before the call**.
- One logical send per membership and purpose: `Message.sendKey` is UNIQUE.
  Never create a second outbound message to retry; reuse the same row.
- `STEP_1_SENT` only after the provider accepted the message.
- `UNCERTAIN` (timeout, 5xx, interrupted send) is never resent automatically.
- Webhooks: verify the provider signature before parsing anything; idempotency
  comes from `ProviderWebhookEvent (provider, eventKey)`; delivery events only
  move `Message.status` forward and never change campaign membership state.
- Hard opt-out handling is deliberately narrow (exact commands only). Anything
  semantic belongs to intent classification, never to `opt-out.ts`.

## Async / jobs policy

- Durable work goes through the `JobQueue` interface (`apps/api/src/jobs/queue.ts`),
  implemented by pg-boss in `jobs/boss.ts` (the only file importing pg-boss; tables
  in the `pgboss` schema). Do not add Redis without a proven need.
- Job names are constants in `jobs/campaign-scheduler.ts`; renaming one orphans
  existing jobs. Workers start only in `server.ts` when `JOB_WORKERS_ENABLED` is
  true — never in tests unless a test starts them explicitly.
- Correctness never depends on pg-boss deduplication: handlers must stay safe
  when duplicated, retried, or run concurrently in several processes.
- Handlers must be idempotent; retries must be bounded; failures must be logged
  with `jobId` and surfaced, never swallowed.

## Reply intelligence rules

- AI is limited to classifying, extracting and drafting grounded answers
  (`providers/ai/index.ts` contract, `openai.ts` the only adapter). Model output
  is validated with Zod (`intentAnalysisSchema`, `groundedAnswerSchema`) before
  use; anything invalid escalates.
- `routeReply` (`modules/replies/router.ts`) is the only place a classification
  maps to an action. Below `CLASSIFIER_CONFIDENCE_THRESHOLD` nothing semantic
  happens. The model's confidence is a routing signal, not a calibrated probability.
- One processing record per inbound message (`ReplyProcessing.inboundMessageId`
  UNIQUE); one automated reply per inbound message (`Message.sendKey`). Replies
  are persisted before sending and sent with `sendConversationalReply`, which
  re-checks suppression immediately before the provider call.
- Business answers come only from active `KnowledgeItem`s retrieved for the
  campaign, and must pass `validateGroundedAnswer`. Never let the model answer
  from general knowledge.
- Replies use fixed operator texts (`config.messages.replies`) or validated
  grounded answers. Never send free-form model text.
- Do not transition members to `QUALIFIED` or `BOOKED` from reply processing;
  Phase 3 owns conversion.

## Conversion rules

- Qualification is decided only by `evaluateQualification`
  (`modules/conversion/evaluator.ts`) from operator rules in the campaign
  config and stored facts. AI only extracts candidate facts
  (`extraction.ts`: strict schema, evidence from the lead's own words).
- Facts never overwrite a higher-precedence source (`facts.ts`).
- One evaluation per inbound message; one question per membership and field;
  one automatic booking offer per membership; one link message per opportunity.
- Questions and links are persisted before sending and sent only through
  `sendConversionMessage` (expected membership state + suppression re-check).
- `BOOKED` is set only in `applyBookingEvent` from a verified provider event;
  a sent link or positive intent never books. Cancellation returns
  `BOOKED → QUALIFIED` and keeps the opportunity row.
- No calendar vendor is selected: do not add an adapter without the user's choice.
- Qualification answers: `routeReply` routes a reply to `QUALIFICATION_ANSWER`
  only while `hasOutstandingQualificationQuestion` is true (ENGAGED, latest
  evaluation pending, its question accepted). Opt-outs and declines keep their
  normal rules. STEP_2_SENT and QUALIFIED are open conversations; BOOKED is not.

## Operational automation rules

- Step 2 goes only through `sendStep2Message` (`modules/followup/step2.ts`),
  one per membership (`<campaignLeadId>:CAMPAIGN_STEP_2`); `STEP_2_SENT` only
  after provider acceptance. Delay = campaign `followUpDelayHours`.
- Final archival only through `archiveDormantMember` (`archival.ts`), after
  campaign `archiveDelayDays` with no inbound reply, escalation or booking.
- CRM, owner notifications and the Service 3 handoff are `IntegrationDelivery`
  outbox rows written in the booking-event transaction and delivered by
  `processIntegrationDelivery`. They never change booking or membership state.
  Unique `idempotencyKey` per logical action; providers receive it.
- No CRM, notification or Service 3 vendor is selected: deliveries become
  `BLOCKED` (`NOT_CONFIGURED`). Do not add adapters without the user's choice.
- One pg-boss cron (`operations-tick`) drives Step 2, archival and deliveries.

## Mission Control rules

- Dashboard metrics are defined once, server-side, in
  `modules/dashboard/metrics.ts` and documented in `docs/mission-control.md`.
  The web app displays them; it never recomputes them.
- Mission Control GET routes only read. Operator controls reuse the owning
  service (`applyCampaignAction`, `setHumanTakeover`).
- Human takeover is `Lead.automationPausedAt`, written only by
  `setHumanTakeover` (`modules/leads/takeover.ts`). Every automated send or
  conversational decision re-checks it (lead row `FOR SHARE`) right before
  acting; new automated paths must do the same. Opt-out handling and
  suppression always run regardless of takeover.
- List endpoints are paginated (`MAX_PAGE_SIZE` in `@cadentor/shared`) with a
  stable id tiebreak.

## Operator access, review and audit rules

- Every `/api/v1` route except webhooks sits behind `authenticateOperators`
  (`middleware/auth.ts`): bearer tokens checked against SHA-256 hashes in
  `OPERATOR_TOKENS`. `/health` and `/ready` are never authenticated; webhooks
  keep provider signature verification and are mounted before operator auth.
- Roles: OPERATOR for reads, campaign lifecycle, takeover and review
  resolution; ADMIN (`requireRole`) for campaign creation, imports, knowledge
  writes and delivery recovery. 401 unauthenticated, 403 wrong role.
- An open review is `OPEN_REVIEW` (`modules/reviews/resolution.ts`: ESCALATED
  and `reviewResolvedAt` null). Every gate that waits for a human uses it.
  Resolution goes only through `resolveReview` / `resumeLeadAutomation`, never
  deletes or rewrites `ReplyProcessing`, and never bypasses suppression,
  terminal states or booking truth.
- Manual operator actions write one `OperatorAuditEvent` via
  `recordOperatorAction` inside the action's transaction, only when state
  changed. The table is append-only (trigger); never store credentials,
  contact data or note text in audit metadata.
- Blocked deliveries return to PENDING only through `requeueBlockedDeliveries`
  (ADMIN, `BLOCKED` + `NOT_CONFIGURED`, configured destinations only).
- Database unavailability maps to 503 `DATABASE_ERROR` only via
  `isDatabaseUnavailableError` (`db/errors.ts`); other errors stay 500.
- The app-level JSON parser skips `/api/v1/webhooks/`; webhook routers read
  raw bodies for signature verification.

## Error & logging policy

- Throw `AppError` subclasses from `apps/api/src/lib/errors.ts`. The error
  middleware produces the shared `ApiErrorBody`; internal detail is logged, not returned.
- No empty `catch`. A catch either handles the error meaningfully, rethrows, or
  converts it to an `AppError` with `cause`.
- Log with the pino logger and the standard `LogContext` fields
  (`requestId, campaignId, leadId, jobId, provider, operation, status, errorCode`).
- Never log API keys, tokens, credentials, full phone numbers/emails, or message bodies.

## Testing policy

- Vitest in both apps (`apps/*/tests`). Tests are deterministic: no real network,
  no real providers, no wall-clock or random dependence (inject clocks/IDs).
- Safety-sensitive logic **requires** deterministic tests before it is considered
  done: suppression, retries, state transitions, webhook idempotency, booking,
  campaign dispatch, rate limits and send windows.
- Database-backed tests use a dedicated test database (see `docs/database.md`),
  never the development database. `npm run test` starts a throwaway embedded
  PostgreSQL automatically; set `TEST_DATABASE_URL` (database name containing
  `test`) to use an existing server. Never mock the database in tests whose
  purpose is a constraint, race, or transaction guarantee.
- Every phase ends with `npm run lint`, `npm run typecheck`, `npm run test` and
  `npm run build` passing.

## Dependency policy

Before installing a package:

1. Check whether the current stack (Node stdlib, Express, Zod, Prisma, pino,
   React, Tailwind) already solves it.
2. Avoid overlapping libraries (one validator, one logger, one HTTP client, one test runner).
3. Prefer mature, maintained packages; pin majors deliberately.
4. Record unusual additions and the reason in the phase completion report.

## Security baseline

- Never commit secrets. `.env*` is ignored except `.env.example`, which holds
  empty placeholders only. Run `npm run check:secrets` before committing.
- Helmet headers, CORS restricted to `WEB_URL`, JSON body limit, validated input.
- Error responses never include stack traces, SQL, connection strings or vendor messages.
- Only `API_URL` / `VITE_*` variables may reach the browser bundle.

## Freeze policy

When a phase is marked **`COMPLETE / VERIFIED / FROZEN`**:

- Later phases must not redesign, restructure or restyle its code.
- Changes are allowed only to fix a demonstrated implementation defect, with the
  defect described to the user before editing.
- Extending frozen code through its existing extension points (new routes, new
  modules, new adapters, new config fields) is allowed.

## Commands

```bash
npm install          # installs, builds shared contracts, generates Prisma client
npm run dev          # shared (watch) + api :4000 + web :5173
npm run build        # shared → api → web
npm run test
npm run lint
npm run typecheck
npm run check:secrets
npm run operator:token -- <id> <OPERATOR|ADMIN>   # new operator token + OPERATOR_TOKENS entry
npm run db:local     # local PostgreSQL on :54329 without Docker (dev only)
npm run db:migrate   # prisma migrate dev (requires DATABASE_URL)
```
