# Dormant Lead & Database Reactivation — Post-Engineering Playbook

**Verify → Demo → Prove → Outreach → Onboard → Sell.**

Engineering is **complete, verified and frozen** (Phases 0–4). Nothing in this playbook
requires writing application code, editing a test, or opening a new engineering phase.
Work the stages in order; each ends with a gate you do not step past.

> **Naming, once, so nobody edits the wrong system later.** This repository calls itself
> **Cadentor — Service 4: Dormant Lead & Database Reactivation Engine**
> (`package.json` → `cadentor-service-4`). The public website sells the same system as
> **05 · PIPELINE RECOVERY — Follow-Up Sequence & Dormant Lead Reactivation**. The
> website's **Service 04 (No-Show & Cancellation Recovery) is a different system** and is
> not this repository. Repo "Service 4" ≠ website "Service 04".

> **Classify every problem before you touch anything.** Only the fourth class below
> permits any change to frozen source, and even then only through the freeze policy in
> [CLAUDE.md](../CLAUDE.md) — describe the defect to the user first, make the smallest safe
> fix, add a deterministic test, re-run lint, typecheck, the whole suite and the build.
>
> | Class                             | Example here                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                             |
> | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **CONFIGURATION ISSUE**           | Startup refuses because `OPERATOR_TOKENS` is malformed; `WEB_URL` is not a bare https origin; `SMS_PROVIDER=twilio` with no `SMS_AUTH_TOKEN`; `CALENDAR_PROVIDER` set at all (no adapter exists)                       | Change the environment variable, restart                                                                                                                                                                                        |
> | **PROVIDER / ENVIRONMENT ISSUE**  | Twilio credentials absent or rejected; OpenAI rate limit; no networked PostgreSQL; a managed database needing TLS                                                                                                      | Fix the account or the environment, or wait                                                                                                                                                                                     |
> | **TEST / DEMO DATA ISSUE**        | The demo campaign's qualification rules do not match the words in your fake reply; the demo CSV has a phone that is already suppressed; a campaign left `PAUSED` from a previous rehearsal                             | Fix the fixture or the demo state — not the code                                                                                                                                                                                |
> | **ENGINEERING DEFECT DISCOVERED** | Reproducible behaviour that contradicts a stated invariant in [CLAUDE.md](../CLAUDE.md) — a send while a lead is suppressed, a `BOOKED` membership without a verified calendar event, an audit row that can be updated | **STOP.** Write down the exact input, the exact observed behaviour, the invariant it violates and the reproduction path. Do **not** fix it in this pass — flag it and keep verifying everything else that does not depend on it |

**Legend:** 🔴 MUST DO BEFORE SELLING · 🟡 NICE TO HAVE · 🔵 CLIENT-SPECIFIC · ⚪ DO LATER ·
💵 COSTS REAL MONEY · ⚠️ MUTATES A REAL RESOURCE (sends a real SMS, writes real state)

**The rule this document exists to enforce: a check that did not run never reports `PASS`.**
`BLOCKED` is an honest result. A hidden `BLOCKED` is a demo you re-record in front of a
prospect — or a message sent to someone who never agreed to receive it.

---

## How to read this document

| Stage                                         | You finish with                                                                   | Blocks                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [0 — Consent](#stage-0)                       | A written answer to "may we legally text this list?", and the gap below contained | **Everything.** No real send to anyone but your own phone until this is settled |
| [1 — Real environment verification](#stage-1) | Independent proof every capability works against real infrastructure              | Everything downstream                                                           |
| [2 — Demo environment](#stage-2)              | One convincing fictional deployment, fully configured                             | Stage 3                                                                         |
| [3 — Test the demo yourself](#stage-3)        | Rehearsed scenes that run clean twice, for presentation only                      | Stage 4                                                                         |
| [4 — Record the Loom](#stage-4)               | A 2–4 minute video that sells the outcome                                         | Stage 6                                                                         |
| [5 — Package the offer](#stage-5)             | Price, inclusions, exclusions, objection answers                                  | Stage 6                                                                         |
| [6 — Outreach & sales](#stage-6)              | A qualified list and ready messages                                               | First call                                                                      |
| [7 — Client onboarding](#stage-7)             | A repeatable collect → configure → verify → deploy → handoff sequence             | First client                                                                    |
| [8 — First 7 days](#stage-8)                  | A day-by-day execution plan                                                       | —                                                                               |

**Companion documents that exist and are current:** [CLAUDE.md](../CLAUDE.md) (the frozen
operating contract) · [docs/database.md](database.md) (schema, hand-written invariants,
migration workflow, test database strategy) · [docs/mission-control.md](mission-control.md)
(metric definitions, API surface, roles, review resolution, takeover semantics) ·
[docs/release.md](release.md) (release readiness, runbooks, known limits).

**Companion documents that exist but are stale — do not hand them to a client and do not
trust them for verification:** [README.md](../README.md) still says _"Current status: PHASE 2"_
and describes the web app as a placeholder; [docs/architecture.md](architecture.md) is
titled _"Architecture — Phase 0 baseline"_. Both predate Phases 3–4. There is **no PRD, no
root ARCHITECTURE.md, no DEPLOYMENT.md and no RUNBOOK.md** in this repository — where the
Speed-to-Lead playbook links to those, this one links to `docs/release.md` or says the
material does not exist.

---

<a id="stage-0"></a>

## STAGE 0 — Consent 🔴 — read this before anything else

Speed-to-Lead replies to someone who raised their hand thirty seconds ago. **This system
initiates contact with people who went quiet months ago.** That single difference moves the
legal and ethical weight from the reply to the _list_, and no amount of engineering quality
substitutes for the right to send.

Under the US TCPA, a marketing or solicitation text to a mobile number generally requires
**prior express written consent**, and opt-outs must be honoured promptly. Equivalent rules
exist elsewhere (CASL in Canada, PECR/UK GDPR in the UK, the Spam Act in Australia). This
playbook is not legal advice; the client's counsel decides what their list permits.

### What the build actually enforces — verified by reading the code

| Control                                                                                      | Enforced? | Where                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global suppression list, checked at import and **again immediately before every send**       | **Yes**   | `modules/suppression/suppression.ts`; `findSuppressed` inside the send claim in `modules/messaging/outbound.ts`, `modules/followup/step2.ts`, `modules/replies/reply-sender.ts`, `modules/conversion/sender.ts` |
| Suppression entries are permanent — the database rejects `UPDATE` and `DELETE`               | **Yes**   | trigger `SuppressionEntry_append_only`, `prisma/migrations/20260914065124_data_foundation/migration.sql`                                                                                                        |
| Exact opt-out commands (`STOP` and siblings) suppress the phone and opt every membership out | **Yes**   | `modules/messaging/opt-out.ts` → `applyHardOptOut` in `modules/messaging/inbound.ts`                                                                                                                            |
| A classified `HARD_OPT_OUT` reply does the same, even under human takeover                   | **Yes**   | `modules/replies/router.ts`, `modules/replies/processor.ts`                                                                                                                                                     |
| Opting out cancels an open booking offer                                                     | **Yes**   | `cancelOpenBookingOffers`, `modules/conversion/booking.ts`                                                                                                                                                      |
| Send window, per-campaign hourly limit, recipient timezone                                   | **Yes**   | `modules/dispatch/eligibility.ts`                                                                                                                                                                               |
| Human takeover pauses all automated sending for one lead                                     | **Yes**   | `Lead.automationPausedAt`, `modules/leads/takeover.ts`                                                                                                                                                          |
| **Consent recorded per contact**                                                             | **NO**    | —                                                                                                                                                                                                               |
| **Consent required before the first message**                                                | **NO**    | —                                                                                                                                                                                                               |

### The gap, stated exactly — `ENGINEERING DEFECT DISCOVERED` 🔴

**There is no consent concept anywhere in this system.** Verified by:

- `grep -rn "consent" .` across the repository (excluding `node_modules` and generated
  Prisma output) returns **zero matches** — no column, no field, no validation, no comment.
- `prisma/schema.prisma` → `model Lead` has `phone`, `email`, `firstName`, `lastName`,
  `source`, `externalId`, `lastServiceAt`, `timezone`, `status`, `automationPausedAt`,
  `firstImportBatchId`. No consent flag, timestamp, source or evidence field.
- `packages/shared/src/api/imports.ts` → `LEAD_INPUT_FIELDS` is exactly `firstName`,
  `lastName`, `phone`, `email`, `source`, `externalId`, `lastServiceDate`, `timezone`. A CSV
  cannot carry consent even when the client has it, because there is no column for it.
  `source` is free text (`VarChar(200)`), never validated, never interpreted as provenance.
- `modules/imports/ingestion.ts` rejects a row only for `MALFORMED_ROW`, `MISSING_PHONE`,
  `INVALID_PHONE`, `PHONE_COUNTRY_REQUIRED`, `DUPLICATE_IN_BATCH`, `SUPPRESSED_PHONE`,
  `SUPPRESSED_EMAIL`, `PERSISTENCE_ERROR`. Nothing about permission.
- `modules/dispatch/eligibility.ts` — the single authoritative dispatch rule — checks
  campaign `ACTIVE`, membership `STAGED`, suppression, timezone availability, send window,
  hourly capacity. **No consent check.**
- `modules/messaging/outbound.ts` → `sendStep1Message` re-checks existing logical send,
  membership `QUEUED`, campaign `ACTIVE`, template present, send window, global suppression,
  human takeover. **No consent check.**

**The exact path that would message a contact who never agreed to anything:**

```text
POST /api/v1/imports/csv  (ADMIN)      any list, any provenance, no consent column
  → ingestion: normalize + dedupe + suppression check only
  → stageLeadsForCampaign                                     membership STAGED
  → campaign-scheduler-tick → admitEligibleMembers            STAGED → QUEUED
  → outbound-dispatch-tick → sendStep1Message                 a real SMS is sent
```

Nothing on that path asks whether the business may contact this person.

**Severity.** The back half of TCPA compliance — honouring opt-outs, permanently, ahead of
every other rule — is genuinely strong and provable. The front half is absent. A client can
upload a purchased list today and this system will message it, inside the send window, at
the configured rate, with no record that anyone agreed.

**What a fix would require** (documentation only here, per the freeze policy): a consent
field on `Lead` (basis, source, captured-at, evidence reference), a required CSV column
through `LEAD_INPUT_FIELDS`, an import outcome reason such as `MISSING_CONSENT`, a consent
term inside `evaluateDispatchEligibility`, and a re-check in every send claim beside the
suppression re-check. That is a schema change, a migration, an edit to a frozen eligibility
rule and new deterministic tests — a real engineering phase, not an edit.

### Containment until that gap is closed — **BLOCKING**

Gate items, not suggestions:

1. **No real send to any number you do not personally control.** Stage 1's first real SMS
   (§1.12) goes to your own handset. The Stage 2 demo list is fictional contacts at numbers
   you own.
2. **No client onboarding without a written consent statement** — Stage 7 requires the
   client to state, in writing, for every list: the lawful basis, where and when consent was
   captured, the wording shown at capture, and who at their business attests to it. File it
   before the first import. If they cannot produce it, do not import the list.
3. **Say it out loud on the sales call.** "This messages people who already gave you
   permission to contact them. If your list does not have that, this is not the system for
   you — and I would rather tell you now."
4. Record the decision: while the gap is open, the compliance control is a human one — the
   client's attestation plus your refusal to import unattested lists — and it is only as
   strong as your discipline.

---

## The complete HTTP surface

Every route below exists in the frozen build (`apps/api/src/routes/`). Unlike Speed-to-Lead,
this service **has a web UI**: Mission Control (`apps/web`), which calls exactly these routes.

| Method | Path                                                               | Auth                   | Notes                                                                                       |
| ------ | ------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                                                          | **none**               | Liveness. Process only, no I/O                                                              |
| `GET`  | `/ready`                                                           | **none**               | `{ status, checks: { database, jobs }, timestamp }`. `200` ready, `503` not                 |
| `POST` | `/api/v1/webhooks/messaging/:provider/inbound`                     | **provider signature** | Mounted only when `SMS_PROVIDER` is set. Raw form body, verified before parsing             |
| `POST` | `/api/v1/webhooks/messaging/:provider/status`                      | **provider signature** | Delivery status callbacks                                                                   |
| `POST` | `/api/v1/webhooks/calendar/:provider`                              | **provider signature** | Mounted only when a calendar provider is configured — **no adapter exists today**           |
| `GET`  | `/api/v1/auth/me`                                                  | OPERATOR+              | `{ id, role }` for the presented token                                                      |
| `POST` | `/api/v1/imports/csv`                                              | **ADMIN**              | `multipart/form-data`: `file`, optional `source`, `defaultCountry`, `campaignId`, `mapping` |
| `GET`  | `/api/v1/imports/:id`                                              | **ADMIN**              | Import batch detail with per-row outcomes                                                   |
| `POST` | `/api/v1/campaigns`                                                | **ADMIN**              | Creates a `DRAFT` campaign, `201`                                                           |
| `GET`  | `/api/v1/campaigns/:id`                                            | OPERATOR+              | Summary, membership counts, dispatch capacity                                               |
| `GET`  | `/api/v1/campaigns/:id/overview`                                   | OPERATOR+              | Metrics, capacity, recent activity                                                          |
| `POST` | `/api/v1/campaigns/:id/start` · `/pause` · `/resume` · `/complete` | OPERATOR+              | The only path that changes campaign status. Audited                                         |
| `GET`  | `/api/v1/knowledge`                                                | OPERATOR+              | Approved facts used for grounded answers                                                    |
| `POST` | `/api/v1/knowledge` · `POST /api/v1/knowledge/:id/deactivate`      | **ADMIN**              | Writes are ADMIN-only                                                                       |
| `GET`  | `/api/v1/dashboard/overview`                                       | OPERATOR+              | KPI metrics                                                                                 |
| `GET`  | `/api/v1/dashboard/campaigns`                                      | OPERATOR+              | Campaign table, `?status=`                                                                  |
| `GET`  | `/api/v1/conversations`                                            | OPERATOR+              | `?filter=all\|attention\|takeover`, `?campaignId=`                                          |
| `GET`  | `/api/v1/conversations/:leadId`                                    | OPERATOR+              | Message history, oldest first                                                               |
| `GET`  | `/api/v1/reviews`                                                  | OPERATOR+              | `?state=OPEN\|RESOLVED`, `?reason=`, `?campaignId=`                                         |
| `POST` | `/api/v1/reviews/:id/resolve`                                      | OPERATOR+              | `{ resolution, note? }`                                                                     |
| `GET`  | `/api/v1/leads/:id`                                                | OPERATOR+              | Suppression, memberships, facts, bookings, deliveries                                       |
| `POST` | `/api/v1/leads/:id/takeover` · `/resume-automation`                | OPERATOR+              | Human takeover on/off                                                                       |
| `GET`  | `/api/v1/audit`                                                    | OPERATOR+              | Operator audit events, `?targetType=`, `?targetId=`                                         |
| `GET`  | `/api/v1/integrations/health`                                      | OPERATOR+              | Delivery counts, calendar events, recent failures                                           |
| `POST` | `/api/v1/integrations/requeue-blocked`                             | **ADMIN**              | Requeue `BLOCKED` + `NOT_CONFIGURED` deliveries                                             |

List endpoints take `page` (≥ 1) and `pageSize` (1–100, default 25 — `DEFAULT_PAGE_SIZE` and
`MAX_PAGE_SIZE` in `@cadentor/shared`).

**There is no HTTP route that adds a suppression entry.** Suppression is created by import
(matching existing entries), by an inbound opt-out, or by a provider opt-out signal. A
client's existing do-not-contact list therefore cannot be loaded through the API — a named
onboarding constraint in [§7.1](#71-collect-before-you-configure).

### Every error code the API returns

`VALIDATION_ERROR` (400) · `UNAUTHORIZED` (401) · `FORBIDDEN` (403) · `NOT_FOUND` (404) ·
`CONFLICT` (409) · `PAYLOAD_TOO_LARGE` (413) · `RATE_LIMITED` (429) · `PROVIDER_ERROR` (502) ·
`CONFIGURATION_ERROR` (500) · `DATABASE_ERROR` (503) · `INTERNAL_ERROR` (500).

Every non-2xx body is `{ "error": { "code", "message", "requestId", "issues"? } }` — no stack
trace, no SQL, no connection string, no vendor message.

### Every npm script that exists

`dev`, `build`, `start`, `test`, `lint`, `typecheck`, `format`, `format:check`,
`check:secrets`, `operator:token`, `db:local`, `db:generate`, `db:migrate`, `db:deploy`,
`db:status` (plus `postinstall`).

**What does NOT exist here that the Speed-to-Lead playbook leans on:**

| Missing                                | Consequence for this playbook                                                                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `preflight`                         | Configuration refusal is proven by attempting `npm start` and reading the refusal (§1.4)                                                                                                                                                                  |
| No `ops:snapshot`                      | Operational state is read from Mission Control or SQL                                                                                                                                                                                                     |
| No `KILL_SWITCH`                       | **There is no global pause.** Nearest equivalents: per-campaign `pause`, per-lead takeover, `JOB_WORKERS_ENABLED=false` (stops the workers that send), unsetting `SMS_PROVIDER` (disables outbound entirely; needs a restart). §1.19 covers this honestly |
| No `Dockerfile` / `docker-compose.yml` | There is no image to build or verify. §1.20 is `NOT APPLICABLE`; hosting is a plain Node process                                                                                                                                                          |
| No live provider smoke scripts         | The first real Twilio and OpenAI calls happen through the real pipeline (§1.12–§1.14)                                                                                                                                                                     |
| No seed script                         | Demo data is created through the real import and campaign routes                                                                                                                                                                                          |
| No suppression route or CLI            | A client's DNC list cannot be imported; see §7.1                                                                                                                                                                                                          |

### The complete configuration surface

`.env.example` is the source of truth.

| Area              | Variables                                                                                                                                                                                                                   | Required                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Runtime           | `NODE_ENV`, `LOG_LEVEL`                                                                                                                                                                                                     | Defaults `development` / `info`                                                                   |
| Database          | `DATABASE_URL`                                                                                                                                                                                                              | **Required in production**                                                                        |
| HTTP              | `API_PORT`, `WEB_URL`, `API_URL`, `TRUST_PROXY`                                                                                                                                                                             | `WEB_URL` required in production; both URLs https there; `WEB_URL` must be a bare origin          |
| Operator access   | `OPERATOR_TOKENS`                                                                                                                                                                                                           | **Required in production.** `id:ROLE:sha256` entries, comma-separated. Unset = nobody can sign in |
| AI                | `OPENAI_API_KEY`, `OPENAI_MODEL`                                                                                                                                                                                            | Optional. Unset = inbound replies stored, never classified. Model required when the key is set    |
| Messaging         | `SMS_PROVIDER`, `SMS_ACCOUNT_ID`, `SMS_AUTH_TOKEN`, `SMS_FROM_NUMBER`                                                                                                                                                       | Optional. Set = other three required, and `API_URL` must be public https in production            |
| Future providers  | `CALENDAR_PROVIDER`, `CRM_PROVIDER`, `OWNER_NOTIFICATION_PROVIDER`                                                                                                                                                          | **Leave unset — any value stops startup, because no adapter exists**                              |
| Campaign defaults | `DEFAULT_CAMPAIGN_TIMEZONE`, `CAMPAIGN_SEND_WINDOW_START`, `CAMPAIGN_SEND_WINDOW_END`, `CAMPAIGN_HOURLY_DISPATCH_LIMIT`, `CAMPAIGN_FOLLOW_UP_DELAY_HOURS`, `CAMPAIGN_ARCHIVE_DELAY_DAYS`, `CLASSIFIER_CONFIDENCE_THRESHOLD` | Defaults exist; each campaign snapshots its own config at creation                                |
| Imports           | `IMPORT_MAX_FILE_BYTES`                                                                                                                                                                                                     | Default 10 MiB, max 100 MiB                                                                       |
| Jobs              | `JOB_WORKERS_ENABLED`                                                                                                                                                                                                       | Default `true`. `false` runs an API-only process                                                  |

Per-campaign behaviour (message templates, qualification rules, booking link) is **not**
environment configuration — it is the campaign's own `config` JSON, snapshotted at creation
so later environment changes never alter a running campaign.

---

## Gaps carried forward from the freeze

Named debts. Each gets a verification subsection in Stage 1.

| #         | Gap                                                                                                                                                                                                                                           | Status                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **GAP 1** | **Twilio** credentials never configured — **no real SMS has ever been sent by this system**                                                                                                                                                   | BLOCKED                      |
| **GAP 2** | **OpenAI** credentials never configured — no real completion has ever been made; no reply has ever been classified by a real model                                                                                                            | BLOCKED                      |
| **GAP 3** | **Calendar adapter does not exist.** `BOOKED` is reachable only from a verified calendar webhook, so **no booking can be confirmed today**. Needs a vendor decision                                                                           | BLOCKED                      |
| **GAP 4** | **CRM, owner-notification and Service 3 handoff adapters do not exist.** Every booking delivery lands `BLOCKED` / `NOT_CONFIGURED`. Needs vendor decisions                                                                                    | BLOCKED                      |
| **GAP 5** | The **Service 3 handoff cannot be completed** until the Google Review Agent exists — being built in parallel                                                                                                                                  | BLOCKED, external dependency |
| **GAP 6** | **No networked/managed PostgreSQL run.** The suite runs against a real PostgreSQL started from `embedded-postgres` binaries locally (or `TEST_DATABASE_URL` when set). TLS, pooling and a managed provider's limits have never been exercised | Untested                     |
| **GAP 7** | **No container.** No Dockerfile exists; the image has never been built because there is nothing to build                                                                                                                                      | Not applicable by design     |

**Residual risks to carry into deployment and handoff, not a footnote:**

- Rate limits are per-process and in memory — N API instances allow N× the limit.
- Revoking or rotating an operator token requires an **API restart**. No SSO, no session
  list, no password reset.
- The `/ready` `jobs` check reflects start/stop only: a pg-boss that lost its database after
  a successful start still reports `up`, while `database` reports `down`.
- The conversation list scans messages per page — fine at single-business volume.
- On narrow screens the review resolution form sits inside a horizontally scrolling table.
- **Unreproduced quirk:** in an automated browser, pressing <kbd>Enter</kbd> in the sign-in
  field did not submit the form; clicking **Sign in** did. Never reproduced by hand. §1.9
  includes a manual check.

---

<a id="stage-1"></a>

## STAGE 1 — Real environment verification 🔴

**Objective:** independently prove every capability against real infrastructure, on your own
scratch resources, before a single sales message goes out. Nothing here depends on Stage 2
or 3 — Stage 3 later _reuses_ what is proven here to rehearse a presentation.

At the freeze the suite ran against a **real PostgreSQL** started from `embedded-postgres`
binaries (not an in-process emulator) with fake providers injected. That proves the SQL,
the constraints, the triggers and the business logic genuinely. What no automated test has
ever done: opened a connection to a managed database, called Twilio, called OpenAI, or
rendered the UI in a real browser.

> ⚠️ **Scratch infrastructure only, throughout this stage.** A throwaway PostgreSQL, your
> own Twilio trial number, your own OpenAI key, **your own mobile phone as the only
> recipient**. Never a client's database, credentials or contact list. Several steps below
> send a real SMS and write real database state.

**Budget:** a few dollars. A Twilio trial covers the sends; one or two OpenAI completions
cost cents.

### 1.1 Local baseline — clean install, lint, typecheck, full suite, build

|                     |                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Need**            | Node.js ≥ 22.12, npm 10+, a clean checkout                                                                                                                                                                             |
| **Configure**       | Nothing                                                                                                                                                                                                                |
| **Run**             | `npm ci` → `npm run lint` → `npm run typecheck` → `npm test` → `npm run build`                                                                                                                                         |
| **Expected result** | Lint and typecheck clean; the API suite reports **42 test files / 414 tests passing**, the web suite **2 files / 15 tests passing**, 0 failing in both; `apps/api/dist/server.js` and `apps/web/dist/index.html` exist |
| **PASS condition**  | All five commands exit `0` and the printed counts match                                                                                                                                                                |
| **Costs money**     | No                                                                                                                                                                                                                     | **Destructive** | No  | **Scratch infra mandatory** | No  |

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build && ls apps/api/dist/server.js apps/web/dist/index.html
```

`npm test` starts a throwaway PostgreSQL in a temp directory, applies every migration with
`prisma migrate deploy`, and truncates tables between tests. It needs no database of your
own and leaves nothing behind. If `TEST_DATABASE_URL` is set it uses that instead — the
database name must contain `test`, because the suite truncates every table.

**Also run the secret scan and the formatter check** — both are part of the frozen
definition of done:

```bash
npm run check:secrets
npm run format:check
```

**What to do if it fails:** any of these failing on an unmodified checkout →
`ENGINEERING DEFECT DISCOVERED`. Do not spend a cent verifying anything downstream of a
build that does not pass its own suite.

### 1.2 GAP 6 — the suite and the API against a networked / managed PostgreSQL 🔴

**Carried forward from the freeze.** Everything so far has run against a local PostgreSQL on
a loopback socket with no TLS, no connection limit worth hitting and no proxy. Production is
a managed instance behind TLS, often behind a pooler.

|                     |                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| **Need**            | A **throwaway** managed PostgreSQL 14+ (Supabase, Neon, RDS) — never a client's                 |
| **Configure**       | `TEST_DATABASE_URL` for the suite (database name containing `test`), `DATABASE_URL` for the API |
| **Run**             | `TEST_DATABASE_URL=... npm test`, then the rest of Stage 1 against `DATABASE_URL`               |
| **Expected result** | Identical counts to §1.1                                                                        |
| **PASS condition**  | Same counts, no connection or TLS errors, no test that passes locally and fails there           |
| **Costs money**     | Free tier is enough                                                                             | **Destructive** | **Yes — truncates every table between tests** | **Scratch infra mandatory** | **Yes** |

```bash
TEST_DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/cadentor_test?sslmode=require" npm test
```

There is **no `test:pg` wrapper** in this repository and no banner that announces which
database was used — `npm test` silently prefers `TEST_DATABASE_URL` when it is set. Confirm
you actually hit the remote server by watching its connection count or logs while the suite
runs, or by checking that the tables exist there afterwards (§1.3).

**What to do if it fails:** connection or TLS failures are a **PROVIDER / ENVIRONMENT
ISSUE**. A test that passes locally and genuinely fails against a managed server is exactly
the class of bug this gap exists to find → `ENGINEERING DEFECT DISCOVERED`; do not weaken
the test.

### 1.3 Migrations against a real server

|                     |                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------- |
| **Need**            | A scratch database **separate** from the test one (the test database gets truncated)         |
| **Configure**       | `DATABASE_URL` in `.env`                                                                     |
| **Run**             | `db:status` → `db:deploy` → `db:status` → `db:deploy` again                                  |
| **Expected result** | Eight migrations pending, then applied, then none pending; the second deploy applies nothing |
| **PASS condition**  | Both later `db:status` runs report the schema up to date                                     |
| **Costs money**     | No                                                                                           | **Destructive** | Creates tables on the target | **Scratch infra mandatory** | Yes |

```bash
npm run db:status
npm run db:deploy
npm run db:status
npm run db:deploy      # PASS condition: this changes nothing
```

**The eight migrations, in order:** `20260914065124_data_foundation`,
`20260914103226_dispatch_admission`, `20260914163731_messaging_foundation`,
`20260914172036_reply_intelligence`, `20260915052514_qualification_booking`,
`20260915063933_operational_automation`, `20260915073248_mission_control`,
`20260915103741_release_hardening`.

Confirm the hand-written invariants really exist — they are not tracked by Prisma drift
detection, so this is the only way to know (any SQL client works; `psql` shown):

```bash
psql "$DATABASE_URL" -c "\dt"
psql "$DATABASE_URL" -c "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname;"
```

**Expected triggers:** `SuppressionEntry_append_only` and `OperatorAuditEvent_append_only`.
The full list of CHECK constraints and partial indexes is in
[docs/database.md → Hand-written invariants](database.md).

**What to do if it fails:** a missing trigger or constraint after a clean deploy →
`ENGINEERING DEFECT DISCOVERED`; the append-only guarantees in this playbook depend on them.

### 1.4 Production configuration refusal 🔴

There is no `preflight` command here. Configuration is validated by Zod at startup, so the
refusal is proven by attempting to boot. Every case below must refuse, naming the variable,
**never echoing the value**.

|                     |                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| **Need**            | §1.3 complete                                                                                    |
| **Configure**       | Break one variable at a time on the command line, then drop it                                   |
| **Run**             | `npm start` (from `apps/api`, or `npm run start` at the root)                                    |
| **Expected result** | The process exits `1` with `[startup] Invalid environment configuration:` and the offending keys |
| **PASS condition**  | Every case refuses; no token, hash or connection string appears in the output                    |
| **Costs money**     | No                                                                                               | **Destructive** | No  | **Scratch infra mandatory** | Recommended |

| #   | Break this                                                       | Expected refusal                                                  |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | `NODE_ENV=production` with no `OPERATOR_TOKENS`                  | `OPERATOR_TOKENS: is required in production`                      |
| 2   | `NODE_ENV=production` with no `DATABASE_URL` / no `WEB_URL`      | each named `is required in production`                            |
| 3   | `OPERATOR_TOKENS="alice:ROOT:<64 hex>"`                          | `entry 1 must be <id>:<OPERATOR\|ADMIN>:<64-hex sha256>`          |
| 4   | `OPERATOR_TOKENS="alice:ADMIN:plaintext-token"`                  | refused, and **`plaintext-token` must not appear in the message** |
| 5   | Two entries, same id                                             | `operator ids must be unique`                                     |
| 6   | Two entries, same hash                                           | `each operator must have its own token`                           |
| 7   | `NODE_ENV=production`, `API_URL=http://api.example.com`          | `must be an https URL in production`                              |
| 8   | `NODE_ENV=production`, `WEB_URL=http://ops.example.com`          | `must be an https URL in production`                              |
| 9   | `WEB_URL=https://ops.example.com/app?x=1`                        | `must be a bare origin such as https://ops.example.com`           |
| 10  | `SMS_PROVIDER=twilio` with no `SMS_AUTH_TOKEN`                   | `is required when SMS_PROVIDER is set`                            |
| 11  | `SMS_PROVIDER=twilio`, `SMS_ACCOUNT_ID=not-a-sid`                | `must be a Twilio Account SID (AC followed by 32 hex characters)` |
| 12  | `OPENAI_API_KEY` set, `OPENAI_MODEL` unset                       | `is required when OPENAI_API_KEY is set`                          |
| 13  | `CALENDAR_PROVIDER=anything`                                     | `CALENDAR_PROVIDER "anything" has no adapter` — startup stops     |
| 14  | `CRM_PROVIDER=anything` / `OWNER_NOTIFICATION_PROVIDER=anything` | same shape — no adapter exists                                    |

```bash
NODE_ENV=production npm start                                   # case 1 and 2
OPERATOR_TOKENS="alice:ADMIN:plaintext-token" npm start          # case 4
WEB_URL="https://ops.example.com/app?x=1" npm start              # case 9
CALENDAR_PROVIDER=calendly npm start                             # case 13
```

**What to do if it fails:** any case that boots instead of refusing, or any output
containing a token, a hash or a password, → `ENGINEERING DEFECT DISCOVERED`.

### 1.5 Boot, `/health`, `/ready`, and a real database outage 🔴

|                     |                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Need**            | §1.3 and §1.4 complete, a valid `OPERATOR_TOKENS` (see §1.7)                                                 |
| **Configure**       | `DATABASE_URL`, `JOB_WORKERS_ENABLED=true`                                                                   |
| **Run**             | `npm start`, then `curl` in another terminal                                                                 |
| **Expected result** | `/health` answers from nothing; `/ready` reports `database` and `jobs`                                       |
| **PASS condition**  | `/health` `200`; `/ready` `200` with `{"database":"up","jobs":"up"}`; neither response contains a credential |
| **Costs money**     | No                                                                                                           | **Destructive** | No  | **Scratch infra mandatory** | Yes |

```bash
npm start
```

```bash
curl -s localhost:4000/health
curl -s localhost:4000/ready
```

Expected shapes, verified live against this build:

```json
{"status":"ok","service":"cadentor-reactivation-api","uptimeSeconds":26,"timestamp":"..."}
{"status":"ready","checks":{"database":"up","jobs":"up"},"timestamp":"..."}
```

`jobs` reports `not_configured` when `JOB_WORKERS_ENABLED=false` — an API-only instance is
ready, by design. Confirm that too, then restore workers.

**Now the database-outage path — this is the 503 that Phase 4 / Prompt 2 exists to make
honest.** With the API running, stop or pause the scratch database:

|                     |                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Expected result** | `/ready` → `503` with `"database":"down"`; `/health` stays `200`; an operator API call → `503` with `{"error":{"code":"DATABASE_ERROR","message":"Database is unavailable","requestId":"..."}}`; the process does **not** die |
| **PASS condition**  | All four, **and** `/ready` returns to `200` on its own once the database is back — no restart                                                                                                                                 |

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/ready
curl -s -H "Authorization: Bearer $OPS_TOKEN" localhost:4000/api/v1/dashboard/overview
```

The response must name no host, no port, no driver and no SQL. Mission Control renders this
as _"Service unavailable: the database cannot be reached. Retrying automatically."_ (§1.8).

**What to do if it fails:** a `500` instead of `503`, a leaked connection string, or a
process that dies with the database → `ENGINEERING DEFECT DISCOVERED`.

### 1.6 Auth and roles at the API 🔴

|                     |                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| **Need**            | §1.5 running; an OPERATOR token and an ADMIN token (§1.7)                                                 |
| **Run**             | The calls below                                                                                           |
| **Expected result** | `401` unauthenticated · `403` wrong role · `429` after repeated invalid tokens · `200` for the right role |
| **PASS condition**  | Every row below, and all `401` bodies structurally identical                                              |
| **Costs money**     | No                                                                                                        | **Destructive** | No  | **Scratch infra mandatory** | Yes |

```bash
B=http://localhost:4000
curl -s -o /dev/null -w '%{http_code}\n' $B/api/v1/dashboard/overview                                   # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Basic abc" $B/api/v1/dashboard/overview       # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer wrong-token-0123456789" $B/api/v1/dashboard/overview  # 401
curl -s -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/auth/me                                          # {"id":"...","role":"OPERATOR"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/integrations/requeue-blocked   # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $B/api/v1/integrations/requeue-blocked # 200
```

Then prove the brute-force limit, from a client IP you do not mind blocking for 15 minutes:

```bash
for i in $(seq 1 11); do
  curl -s -o /dev/null -w '%{http_code} ' -H "Authorization: Bearer definitely-wrong" $B/api/v1/auth/me
done; echo
```

**Expected:** ten `401`s then `429`. While blocked, **a valid token is also refused with
`429`** — that is deliberate. `/health` and `/ready` keep answering `200` throughout.

**Webhooks must not be rate limited and must not require an operator token** — provider
retries would otherwise be refused. Webhook routers are mounted _before_ the auth middleware
in `routes/api.ts`; §1.11 proves signature verification still holds. Note the consequence:
with `SMS_PROVIDER` unset the webhook router is not mounted at all, so that path answers
`401` from the operator middleware rather than `404`.

**What to do if it fails:** any `200` for an unauthenticated or wrongly-roled request →
`ENGINEERING DEFECT DISCOVERED`, and stop — that boundary is the only thing between the open
internet and a system that sends messages.

### 1.7 Operator tokens — issue, rotate, revoke 🔴

|                     |                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Need**            | Nothing                                                                                                                            |
| **Run**             | `npm run operator:token -- <id> <OPERATOR\|ADMIN>`                                                                                 |
| **Expected result** | A raw token printed once, plus an `id:ROLE:sha256` entry for `OPERATOR_TOKENS`                                                     |
| **PASS condition**  | The raw token appears **only** in your terminal, never in a file; the API accepts it; removing the entry and restarting refuses it |
| **Costs money**     | No                                                                                                                                 | **Destructive** | No  | **Scratch infra mandatory** | No  |

```bash
npm run operator:token -- ops OPERATOR
npm run operator:token -- admin ADMIN
```

Put both entries, comma-separated, in `OPERATOR_TOKENS`. Then prove revocation honestly:

```bash
# remove the ops entry from OPERATOR_TOKENS, restart the API, then:
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/auth/me   # 401
```

**Revocation requires a restart.** There is no session list and no revocation endpoint —
state that plainly at handoff (§7) rather than discovering it during an incident.

### 1.8 Mission Control in a real browser 🔴

The Speed-to-Lead service has no UI; this one does, and it has never been driven by a human
in a browser against a real deployment. Everything below is manual and visual.

|                     |                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Need**            | API running (§1.5); `npm run dev -w @cadentor/web` or the built `apps/web/dist` served somewhere; `WEB_URL` matching that origin |
| **Configure**       | `API_URL` pointing at the API                                                                                                    |
| **Run**             | Open the UI, sign in, click through every surface                                                                                |
| **Expected result** | The table below, every row                                                                                                       |
| **PASS condition**  | Every row, seen with your own eyes                                                                                               |
| **Costs money**     | No                                                                                                                               | **Destructive** | No  | **Scratch infra mandatory** | Yes |

| #   | Check                                                                                         | PASS condition                                                                                 |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Load the app signed out                                                                       | The sign-in card only. No dashboard data, no network call to a data route                      |
| 2   | Paste the OPERATOR token, **click Sign in**                                                   | Header shows the operator id and `OPERATOR`; Overview loads                                    |
| 3   | Paste a wrong token                                                                           | _"That token was not accepted. Check it and try again."_; the stored token is cleared          |
| 4   | Sign in, then remove the entry from `OPERATOR_TOKENS` and restart the API, then act in the UI | _"Your session ended. Sign in again."_ and the sign-in card returns                            |
| 5   | As OPERATOR, open Integration health with blocked deliveries present                          | The requeue button is **absent**; the text says to ask an administrator                        |
| 6   | As ADMIN                                                                                      | The **Requeue blocked deliveries** button is present, and asks for confirmation before posting |
| 7   | Force a 403 (an OPERATOR attempting an ADMIN action)                                          | A human-readable _"Not permitted: Requires the ADMIN role"_, not a raw code                    |
| 8   | Stop the database while the UI is open                                                        | _"Service unavailable: the database cannot be reached. Retrying automatically."_               |
| 9   | Restart the database                                                                          | Panels recover on their own within one poll interval (20–60s), no page reload                  |
| 10  | Human review queue                                                                            | Open items listed; the **Resolve** form opens with the resolutions valid for that review       |
| 11  | Operator activity panel (Overview)                                                            | Your campaign actions from §1.10 appear, newest first                                          |
| 12  | Sign out                                                                                      | Returns to the sign-in card; a reload does not restore the session                             |

**The Enter-key quirk — check it by hand.** In an automated browser, pressing
<kbd>Enter</kbd> in the token field did not submit; clicking **Sign in** did. It has never
been reproduced manually.

|                    |                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run**            | Type a valid token, press <kbd>Enter</kbd> (do not click)                                                                                                              |
| **PASS condition** | The form submits and you are signed in                                                                                                                                 |
| **If it does not** | `ENGINEERING DEFECT DISCOVERED` — minor, cosmetic, but write it down with the browser and version. Document the workaround (click the button) for operators either way |

### 1.9 Mission Control read models against real data

Once §1.12–§1.16 have produced real messages, come back and confirm the dashboard reports
**database truth**, not guesses:

| Surface             | PASS condition                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview KPIs       | Match the definitions in [docs/mission-control.md](mission-control.md). "Outbound sent" counts only provider-accepted messages; a `PENDING` or `FAILED` message is not "sent" |
| Appointments booked | `0` until a verified calendar event exists. **A sent booking link is never a booking** — with GAP 3 open this stays `0` permanently                                           |
| Campaign table      | Membership counts equal `SELECT status, count(*) FROM "CampaignLead" GROUP BY 1` for that campaign                                                                            |
| Conversations       | The list shows only the last four digits of a phone number; the thread shows the real message text (the operator needs it)                                                    |
| Lead detail         | Suppression state, memberships, qualification facts, bookings and delivery rows all present                                                                                   |
| Reviews             | `state=OPEN` excludes anything resolved                                                                                                                                       |

### 1.10 Campaign lifecycle and the audit trail 🔴

|                     |                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| **Need**            | §1.6 complete, an ADMIN token                                                                       |
| **Run**             | Create a campaign, start it, pause it, repeat the pause, read the audit                             |
| **Expected result** | Lifecycle rules enforced by the server; one audit row per real change; none for the rejected repeat |
| **PASS condition**  | The four assertions below                                                                           |
| **Costs money**     | No                                                                                                  | **Destructive** | Writes campaign rows | **Scratch infra mandatory** | Yes |

```bash
CAMPAIGN=$(curl -s -X POST $B/api/v1/campaigns -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Verification campaign"}' | jq -r .id)

curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/campaigns/$CAMPAIGN/start   # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/campaigns/$CAMPAIGN/pause   # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/campaigns/$CAMPAIGN/pause   # 409
curl -s -H "Authorization: Bearer $OPS_TOKEN" "$B/api/v1/audit?targetType=CAMPAIGN&targetId=$CAMPAIGN" | jq '.total, .items[].action'
```

1. `start` → `200`, `pause` → `200`, the repeated `pause` → `409 CONFLICT`.
2. The audit has **exactly two** rows: `CAMPAIGN_START`, `CAMPAIGN_PAUSE`. The rejected
   repeat wrote nothing.
3. Each row carries `actorId`, `actorRole`, `targetId` and the request id.
4. No audit row contains a token, a phone number or message text.

### 1.11 Webhook signature verification and raw bodies 🔴

|                     |                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| **Need**            | `SMS_PROVIDER=twilio` plus the three Twilio variables, `API_URL` set to the public URL Twilio will call |
| **Run**             | Post to the inbound webhook with no signature, a wrong signature, and a correct one                     |
| **Expected result** | `403` for the first two, provider ack for the third, and no side effect from the refused ones           |
| **PASS condition**  | All three, plus one `Message` row for the accepted delivery and none for the refused                    |
| **Costs money**     | No                                                                                                      | **Destructive** | Writes message rows | **Scratch infra mandatory** | Yes |

The simplest honest way to produce a correctly signed request is the provider itself: point
your Twilio number's messaging webhook at `<API_URL>/api/v1/webhooks/messaging/twilio/inbound`
and text the number from your own phone (this happens naturally in §1.13). For the negative
cases:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'MessageSid=SM_test&From=%2B15555550123&To=%2B15555550100&Body=hello' \
  $B/api/v1/webhooks/messaging/twilio/inbound            # 403 — no signature

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/x-www-form-urlencoded' -H 'x-twilio-signature: not-a-signature' \
  --data 'MessageSid=SM_test&From=%2B15555550123&To=%2B15555550100&Body=hello' \
  $B/api/v1/webhooks/messaging/twilio/inbound            # 403
```

Confirm nothing was written:

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM \"ProviderWebhookEvent\";"
```

**Raw-body handling matters and is easy to break.** The app-level JSON parser deliberately
skips `/api/v1/webhooks/`, so a provider that signs the exact raw bytes verifies correctly.
That is covered by `apps/api/tests/security/webhook-raw-body.test.ts` for a JSON-signing
calendar provider and by `apps/api/tests/messaging/webhooks.test.ts` for real Twilio
signatures. **Re-run those two files after any middleware change**, because a generic JSON
parser in front of them would silently break every future signed webhook:

```bash
npm exec -w @cadentor/api -- vitest run tests/security/webhook-raw-body.test.ts tests/messaging/webhooks.test.ts
```

### 1.12 GAP 1 — the first real SMS ⚠️💵🔴

**No message has ever left this system.** This is the first, and the step where a mistake is
expensive: not a stray calendar event, but a text to a real person.

> ⚠️ **Guardrails — all of them, every time.**
>
> 1. The campaign's membership list contains **exactly one lead: your own phone number.**
>    Confirm with SQL before starting the campaign, not after.
> 2. Set `CAMPAIGN_HOURLY_DISPATCH_LIMIT=1` for this run. If anything else is in the list,
>    the blast rate is one message per hour, not hundreds.
> 3. Use a Twilio **trial** number — a trial account can only message verified numbers, so
>    the provider itself refuses an accidental wider send.
> 4. Import with `campaignId` **only** for the one-lead CSV. Never import a real list into a
>    campaign you are about to start.
> 5. Stage 0 stands: your own phone, nobody else's, until consent is solved.

|                     |                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Need**            | A Twilio account, a number, your own mobile verified on it                                                                 |
| **Configure**       | `SMS_PROVIDER=twilio`, `SMS_ACCOUNT_ID`, `SMS_AUTH_TOKEN`, `SMS_FROM_NUMBER`, public `API_URL`, `JOB_WORKERS_ENABLED=true` |
| **Run**             | Create a campaign with a Step 1 template → import a one-row CSV → start → wait for the dispatch tick                       |
| **Expected result** | One SMS on your handset; the membership moves `STAGED → QUEUED → STEP_1_SENT`; the `Message` row is `ACCEPTED`             |
| **PASS condition**  | Exactly one message received, and `STEP_1_SENT` only after the provider accepted it                                        |
| **Costs money**     | **Yes — a few cents**                                                                                                      | **Destructive** | **Sends a real SMS** | **Scratch infra mandatory** | **Yes** |

```bash
cat > /tmp/one-lead.csv <<'CSV'
firstName,lastName,phone
Verification,Handset,+15555550123
CSV
```

```bash
CAMPAIGN=$(curl -s -X POST $B/api/v1/campaigns -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{
    "name":"First real send",
    "config":{
      "hourlyDispatchLimit":1,
      "timezone":"America/New_York",
      "sendWindow":{"start":"09:00","end":"18:00"},
      "messages":{"step1":{
        "body":"Hi {{firstName}}, this is a test from my own system. Reply STOP to opt out.",
        "variables":{},"fallbacks":{"firstName":"there"}}}
    }}' | jq -r .id)

curl -s -X POST $B/api/v1/imports/csv -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F file=@/tmp/one-lead.csv -F source=verification -F defaultCountry=US -F campaignId=$CAMPAIGN | jq '.counts'
```

**Before starting, confirm the list is exactly one lead — your own number:**

```bash
psql "$DATABASE_URL" -c "SELECT l.phone, cl.status FROM \"CampaignLead\" cl JOIN \"Lead\" l ON l.id = cl.\"leadId\" WHERE cl.\"campaignId\" = '$CAMPAIGN';"
```

Only then:

```bash
curl -s -X POST -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/campaigns/$CAMPAIGN/start | jq .status
```

The scheduler tick admits (`STAGED → QUEUED`), the dispatch tick sends. Both run on a
one-minute cron, so allow ~2 minutes. Then:

```bash
psql "$DATABASE_URL" -c "SELECT direction, purpose, status, \"acceptedAt\" FROM \"Message\" ORDER BY \"createdAt\" DESC LIMIT 3;"
```

**PASS:** one `OUTBOUND / CAMPAIGN_STEP_1 / ACCEPTED` row, one message on your phone, and
the membership at `STEP_1_SENT`.

**Common failure:**

| Symptom                                         | Class                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing sends, membership stuck `STAGED`        | Campaign not `ACTIVE`, outside the send window, or `JOB_WORKERS_ENABLED=false` — **CONFIGURATION**                                      |
| Membership `QUEUED`, message `PENDING`          | Provider rejected retryably — check the Twilio console — **PROVIDER**                                                                   |
| Message `UNCERTAIN`                             | The provider outcome was never established. **It is never resent automatically.** Check the Twilio console before doing anything manual |
| Message `ACCEPTED` but nothing on the handset   | Trial-account restriction or carrier filtering — **PROVIDER**                                                                           |
| `STEP_1_SENT` while the message is not accepted | `ENGINEERING DEFECT DISCOVERED`                                                                                                         |

### 1.13 GAP 2 — a real inbound reply, classified by a real model ⚠️💵🔴

|                     |                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Need**            | §1.12 complete; a real `OPENAI_API_KEY` and `OPENAI_MODEL`; the Twilio number's inbound webhook pointing at your public `API_URL`              |
| **Configure**       | Campaign `messages.replies` texts, and at least one `KnowledgeItem` if you want a grounded answer                                              |
| **Run**             | Reply from your handset with a clear positive ("Yes, I'm interested")                                                                          |
| **Expected result** | The inbound message is stored once, classified, routed deterministically, and the configured reply is sent                                     |
| **PASS condition**  | `ReplyProcessing` shows `COMPLETED` with an action; the membership is `ENGAGED`; you receive the reply text you configured — never model prose |
| **Costs money**     | **Yes — cents**                                                                                                                                | **Destructive** | **Sends a real SMS** | **Scratch infra mandatory** | **Yes** |

```bash
psql "$DATABASE_URL" -c "SELECT status, classification, confidence, action, \"escalationReason\" FROM \"ReplyProcessing\" ORDER BY \"createdAt\" DESC LIMIT 1;"
```

Then prove the escalation path with an ambiguous reply ("hmm maybe?"):

|                     |                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Expected result** | `ReplyProcessing.status = ESCALATED`, a reason such as `LOW_CONFIDENCE` or `AMBIGUOUS_REPLY`, **no automated reply sent** |
| **PASS condition**  | The item appears in Mission Control's review queue, and your handset receives nothing                                     |

**What to do if it fails:** free-form model text arriving on the handset, or a reply sent
for an escalated message, → `ENGINEERING DEFECT DISCOVERED`. Every outbound text is either a
fixed operator template or a grounded answer that passed validation.

### 1.14 A real opt-out, honoured ⚠️🔴

The single most important behaviour in the product, and the one a regulator would ask about.

|                     |                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Need**            | §1.12 complete                                                                                                                |
| **Run**             | Text `STOP` from your handset                                                                                                 |
| **Expected result** | A `SuppressionEntry` for that phone; every membership `OPTED_OUT`; any open booking offer cancelled; no further messages ever |
| **PASS condition**  | All four, plus a second campaign started later never messages that number                                                     |
| **Costs money**     | No                                                                                                                            | **Destructive** | **Permanently suppresses your own number in this database** | **Scratch infra mandatory** | **Yes** |

```bash
psql "$DATABASE_URL" -c "SELECT phone, reason, source FROM \"SuppressionEntry\" ORDER BY \"createdAt\" DESC LIMIT 1;"
psql "$DATABASE_URL" -c "SELECT status FROM \"CampaignLead\" WHERE \"leadId\" = (SELECT id FROM \"Lead\" WHERE phone = '+15555550123');"
```

**Prove suppression outranks everything an operator can do:**

```bash
# create a second campaign, import the same number, start it
psql "$DATABASE_URL" -c "SELECT status, \"errorCode\" FROM \"Message\" WHERE purpose = 'CAMPAIGN_STEP_1' ORDER BY \"createdAt\" DESC LIMIT 1;"
```

**PASS:** the new membership never reaches `STEP_1_SENT`; the message row is `CANCELLED`
with `SUPPRESSED`, or the import recorded the row as `SUPPRESSED` and never staged it.
Nothing arrives on the handset.

Because suppression is append-only, **your own number is now permanently suppressed in this
database.** That is the correct behaviour. Use a second verified number for later steps, or
a fresh scratch database.

### 1.15 The lead state path, walked deliberately

|                     |                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------ |
| **Need**            | §1.13 complete (a lead at `ENGAGED`), campaign `qualification` rules configured            |
| **Run**             | Answer the qualification question from your handset                                        |
| **Expected result** | Facts extracted, one evaluation per inbound message, `QUALIFIED` reached deterministically |
| **PASS condition**  | The table below                                                                            |
| **Costs money**     | Yes, cents                                                                                 | **Destructive** | Sends real SMS | **Scratch infra mandatory** | Yes |

| Transition                       | How it happens                                                | PASS condition                                                                                                         |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `STAGED → QUEUED`                | `admitEligibleMembers` only                                   | A `DispatchAdmission` row records timezone, window and capacity                                                        |
| `QUEUED → STEP_1_SENT`           | Provider accepted the send                                    | Never set before acceptance                                                                                            |
| `STEP_1_SENT → ENGAGED`          | A routed reply                                                | `ReplyProcessing.action` is one of the engaging actions                                                                |
| `ENGAGED → QUALIFIED`            | `evaluateQualification` against the campaign's rules          | A `QualificationEvaluation` row with `result = QUALIFIED`                                                              |
| `QUALIFIED → BOOKED`             | **Only** `applyBookingEvent` from a verified calendar webhook | **BLOCKED by GAP 3 — cannot be reached today**                                                                         |
| `ENGAGED → BOOKED`               | **Removed in Phase 4 / Prompt 2**                             | `canTransitionCampaignLead('ENGAGED','BOOKED')` is `false`; enforced by `apps/api/tests/campaigns/transitions.test.ts` |
| any → `OPTED_OUT`                | Opt-out or suppression                                        | §1.14                                                                                                                  |
| `STEP_2_SENT → DORMANT_ARCHIVED` | `archiveDormantMember` after `archiveDelayDays`               | Only with no inbound reply, no open review and no booking                                                              |

Confirm the booking claim honestly:

```bash
psql "$DATABASE_URL" -c "SELECT status, \"sentAt\", \"confirmedAt\" FROM \"BookingOpportunity\" ORDER BY \"createdAt\" DESC LIMIT 1;"
```

A booking link that was sent shows `OFFERED` with `sentAt` set and `confirmedAt` null. **That
is not a booking.** Until a calendar adapter exists (GAP 3), "Appointments booked" is
structurally `0`, and you must say so when selling.

### 1.16 Human takeover and review resolution 🔴

|                     |                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **Need**            | A lead with an open review (§1.13)                                                       |
| **Run**             | Take over, confirm automation stops, then resolve                                        |
| **Expected result** | The semantics in [docs/mission-control.md](mission-control.md), proven against real data |
| **PASS condition**  | Every row below                                                                          |
| **Costs money**     | No                                                                                       | **Destructive** | Changes real lead state | **Scratch infra mandatory** | Yes |

```bash
LEAD=<leadId from the conversations list>
curl -s -X POST -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/leads/$LEAD/takeover | jq
curl -s -X POST -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/leads/$LEAD/takeover | jq   # changed:false
```

| Check                                   | PASS condition                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Takeover is durable                     | `Lead.automationPausedAt` is set; it survives an API restart                                                                             |
| Repeating takeover                      | `{"changed":false}` and **no second audit row**                                                                                          |
| Automation while paused                 | A further inbound reply is `ESCALATED` with `HUMAN_TAKEOVER`; no automated reply is sent                                                 |
| Opt-out while paused                    | `STOP` still suppresses and opts out — suppression outranks takeover                                                                     |
| Resume                                  | `POST /leads/:id/resume-automation` clears the pause **and** resolves the lead's open reviews as `RESUME_AUTOMATION`, in one transaction |
| Repeating resume                        | `{"changed":false}`, no audit row                                                                                                        |
| Resolve a review twice, same resolution | Second call returns `changed:false`, `resolvedCount:0`, **no second audit row**                                                          |
| Resolve a resolved review differently   | `409 CONFLICT` naming the existing resolution                                                                                            |
| `ARCHIVE` on a `BOOKED` membership      | `409 CONFLICT` — terminal and booking truth are not overridable                                                                          |
| `ARCHIVE` on an eligible membership     | Membership `DORMANT_ARCHIVED`, any `OFFERED` booking offer cancelled, the record kept                                                    |

```bash
curl -s -X POST -H "Authorization: Bearer $OPS_TOKEN" -H 'content-type: application/json' \
  -d '{"resolution":"MARK_HANDLED","note":"Called the customer back"}' \
  $B/api/v1/reviews/<processingId>/resolve | jq
```

**What to do if it fails:** an automated message sent while takeover is on, or a resolution
that bypasses suppression or a terminal state, → `ENGINEERING DEFECT DISCOVERED`.

### 1.17 The audit trigger — prove the database refuses 🔴

A strong, literally demonstrable claim. Do it yourself once so you can say it on a call.

|                     |                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| **Need**            | At least one audit row (§1.10)                                                                      |
| **Run**             | Attempt an `UPDATE` and a `DELETE` directly in SQL                                                  |
| **Expected result** | Both refused by the trigger                                                                         |
| **PASS condition**  | Both raise `OperatorAuditEvent is append-only: UPDATE is not allowed` / `... DELETE is not allowed` |
| **Costs money**     | No                                                                                                  | **Destructive** | No — the point is that it cannot be | **Scratch infra mandatory** | Yes |

```bash
psql "$DATABASE_URL" -c "UPDATE \"OperatorAuditEvent\" SET \"actorId\" = 'someone-else';"
psql "$DATABASE_URL" -c "DELETE FROM \"OperatorAuditEvent\";"
psql "$DATABASE_URL" -c "UPDATE \"SuppressionEntry\" SET phone = '+10000000000';"
```

All three must fail. The same guarantee is covered in
`apps/api/tests/security/operator-access.test.ts`.

**What to do if it fails:** any of them succeeding → `ENGINEERING DEFECT DISCOVERED`, and
stop selling the audit trail until it is fixed.

### 1.18 Blocked-delivery recovery (ADMIN) 🔵

With GAP 4 open, every booking delivery is `BLOCKED` / `NOT_CONFIGURED` — which makes this
the one recovery path you can exercise today, but only once a booking exists (GAP 3). Until
then, verify the command refuses politely and changes nothing:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $B/api/v1/integrations/requeue-blocked | jq
```

**Expected with no adapters configured:**
`{"requeued":0,"byDestination":{"CRM":0,"OWNER_NOTIFICATION":0,"POST_BOOKING_HANDOFF":0}}`
and **no audit row** (nothing changed). Verified live against this build.

The full behaviour — requeue `BLOCKED` + `NOT_CONFIGURED` for configured destinations only,
idempotent, audited once, never touching `FAILED` — is covered by
`apps/api/tests/integrations/recovery.test.ts`. Mark the live half **BLOCKED** until an
adapter exists; do not report it as `PASS`.

### 1.19 Stopping the system — there is no kill switch 🔴

The Speed-to-Lead playbook has `KILL_SWITCH=true`. **This build has no global pause.** Know
the real options before you need them, and rehearse the top two.

| Control                               | Scope         | Takes effect                                 | Stops                                                                                          |
| ------------------------------------- | ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /api/v1/campaigns/:id/pause`    | One campaign  | Immediately, for future admissions and sends | New Step 1/Step 2 sends for that campaign                                                      |
| `POST /api/v1/leads/:id/takeover`     | One lead      | Immediately                                  | Every automated message to that lead                                                           |
| `JOB_WORKERS_ENABLED=false` + restart | Whole process | On restart                                   | All scheduling, sending, reply processing, archival and deliveries. The API still serves reads |
| Unset `SMS_PROVIDER` + restart        | Whole process | On restart                                   | All outbound messaging and the messaging webhooks                                              |
| Complete every campaign               | All campaigns | Immediately, terminal                        | Everything, irreversibly for those campaigns                                                   |

```bash
curl -s -X POST -H "Authorization: Bearer $OPS_TOKEN" $B/api/v1/campaigns/$CAMPAIGN/pause | jq .status
```

**Rehearse the incident:** with a campaign running, pause it and confirm no further Step 1
messages are claimed. Then restart with `JOB_WORKERS_ENABLED=false` and confirm the ticks
stop while `/health` and `/ready` still answer (`jobs: not_configured`).

**What this means for the offer:** you cannot promise "one switch stops everything
instantly". You can promise "any campaign stops in one click, any conversation stops in one
click, and the whole system stops on a restart" — all true and demonstrable.

### 1.20 GAP 7 — container build — `NOT APPLICABLE`

There is no `Dockerfile` and no `docker-compose.yml` in this repository. There is nothing to
build, so this subsection is **NOT APPLICABLE**, not `BLOCKED` and certainly not `PASS`.
Deployment is a plain Node process (§1.21). If a client's platform requires a container,
that is new work, priced as such.

### 1.21 Hosted deployment, paused 🔴

|                     |                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Need**            | A host that runs Node ≥ 22.12 (Render, Railway, Fly, a VM), a scratch managed PostgreSQL (§1.2)                                                                    |
| **Configure**       | Every variable you intend to exercise, in the platform's secret store. Deploy with **every campaign `DRAFT`** and, for the first boot, `JOB_WORKERS_ENABLED=false` |
| **Run**             | Build, migrate as a release step, start, verify                                                                                                                    |
| **Expected result** | Boots, `/ready` `200`, sends nothing                                                                                                                               |
| **PASS condition**  | `/health` `200` · `/ready` `200` (`jobs: not_configured` while workers are off) · §1.6 auth results identical on the hosted instance · no campaign `ACTIVE`        |
| **Costs money**     | Hosting                                                                                                                                                            | **Destructive** | No  | **Scratch infra mandatory** | Yes |

```text
push to GitHub
  → create the service, build command: npm ci && npm run build
  → start command: npm run start
  → provision the scratch database, set DATABASE_URL
  → set OPERATOR_TOKENS, WEB_URL (https, bare origin), API_URL (https), TRUST_PROXY
  → run the release step: npm run db:deploy
  → first deploy with JOB_WORKERS_ENABLED=false     ← the closest thing to a safe pause
  → verify /health, /ready, §1.6 auth
  → deploy the web app with API_URL pointing at the API; confirm CORS from WEB_URL only
  → only then enable workers, and only then start a campaign
```

Point the platform's health check at `/ready`, never `/health` — `/health` answers `200`
while the database is gone, which is exactly what you do not want a load balancer to believe.

### 1.22 Privacy and logging 🔴

|                     |                                                                             |
| ------------------- | --------------------------------------------------------------------------- |
| **Need**            | Captured stdout from the whole Stage 1 session (`npm start > api.log 2>&1`) |
| **Run**             | Grep for everything that must never appear                                  |
| **Expected result** | No match                                                                    |
| **PASS condition**  | Every grep empty                                                            |
| **Costs money**     | No                                                                          | **Destructive** | No  | **Scratch infra mandatory** | No  |

```bash
grep -iE "sk-|AC[0-9a-f]{32}|Bearer " api.log          # provider keys, Twilio SID, bearer tokens
grep -F "$OPS_TOKEN" api.log; grep -F "$ADMIN_TOKEN" api.log
grep -F "+15555550123" api.log                          # the full phone number you messaged
grep -iE "still looking|reply STOP|interested" api.log  # message bodies, in or out
grep -F "$DATABASE_URL" api.log
```

Logs carry `requestId`, `campaignId`, `leadId`, `messageId`, `jobId`, `deliveryId`,
`operatorId`, `operation`, `status` and `errorCode` — identifiers, not content. Authorization
headers and credential-shaped keys are redacted by the logger.

**What to do if it fails:** any secret, full contact detail or message body in a log line →
`ENGINEERING DEFECT DISCOVERED`, and treat it as urgent.

### 1.23 Final Stage-1 audit — the gate 🔴

Reconcile every subsection honestly as **PASS / FAIL / BLOCKED / NOT APPLICABLE**.

- [ ] **§0 Consent** — the gap is documented, and the containment rules are in force. **No
      real send to anyone but your own phone**
- [ ] §1.1 Local baseline — lint, typecheck, `42/414` API, `2/15` web, build, secret scan,
      format check
- [ ] §1.2 **GAP 6** — the suite run against a managed PostgreSQL over TLS
- [ ] §1.3 Eight migrations apply once; a second deploy is a no-op; both append-only triggers present
- [ ] §1.4 Every configuration-refusal case refuses, naming the variable, echoing nothing
- [ ] §1.5 `/health`, `/ready` with `jobs`; a real outage → `503 DATABASE_ERROR`; unattended recovery
- [ ] §1.6 `401` / `403` / `429` all correct; webhooks exempt from operator auth and rate limits
- [ ] §1.7 Tokens issued, accepted, and refused after removal + restart
- [ ] §1.8 Mission Control driven by hand: sign-in, roles, 403, 503, review form, activity panel, Enter-key check
- [ ] §1.9 Dashboard numbers reconciled against SQL
- [ ] §1.10 Lifecycle enforced; exactly one audit row per real change; none for the rejected repeat
- [ ] §1.11 Webhook signatures verified; unsigned and wrongly-signed refused with no side effect
- [ ] §1.12 **GAP 1 closed** — one real SMS, to your own handset, guardrails in place
- [ ] §1.13 **GAP 2 closed** — a real reply classified, routed and answered with operator text
- [ ] §1.14 A real `STOP` honoured permanently; suppression outranks operator action
- [ ] §1.15 The state path walked; `ENGAGED → BOOKED` proven absent; booking **BLOCKED (GAP 3)**
- [ ] §1.16 Takeover and review resolution proven, including the no-op and `409` cases
- [ ] §1.17 The database refuses `UPDATE`/`DELETE` on audit and suppression rows
- [ ] §1.18 Requeue returns `0` with no audit row — live path **BLOCKED (GAP 4)**
- [ ] §1.19 Stopping rehearsed; the absence of a kill switch understood and written down
- [ ] §1.20 Container — **NOT APPLICABLE**
- [ ] §1.21 A hosted deployment is live, with no active campaign
- [ ] §1.22 No secret, contact detail or message body in any log

**Do not:** sell before this gate is green · run any of it against a client's database,
credentials or list · send to any number you do not control · report a `BLOCKED` gap as a
`PASS`.

---

<a id="stage-2"></a>

## STAGE 2 — Build the demo environment 🔴

**Objective:** one convincing fictional deployment. Not five, and nothing invented that the
frozen product does not actually do.

### The niche — proposed, **awaiting your confirmation**

This is a recommendation with reasoning, **not a decision**. Confirm or replace it before
building anything.

| Niche               | Fit for _dormant list reactivation_                                                                                                                                                                                                                                                                                                                                     | Verdict              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Dental practice** | Recall lists are the archetypal dormant database: patients who came once, never rebooked, and already gave contact permission at intake. The consent basis is the strongest of any niche here (existing patient relationship), the "what do we say" question answers itself ("you're due a check-up"), and the value of one recovered patient is high and easy to state | **Proposed**         |
| Med spa             | Works, and it is the Speed-to-Lead niche so the outreach muscle carries over. Weaker here: lists are often ad-sourced leads who never became customers, which is precisely the consent-thin case Stage 0 warns about                                                                                                                                                    | Strong second        |
| Gym / studio        | Large lapsed-member lists, clear reactivation offer, but heavy competition from incumbent retention tooling, and members often cancelled deliberately                                                                                                                                                                                                                   | Viable               |
| Home services       | Seasonal repeat work (gutters, HVAC servicing) fits the Step 1 → Step 2 shape well; lists are often messy, offline, and lack a capture record                                                                                                                                                                                                                           | Viable, consent risk |
| B2B agency lists    | Long cycles, low SMS tolerance, and consent for B2B texting is the murkiest of the set                                                                                                                                                                                                                                                                                  | **Avoid**            |

**Decide before Stage 3.** Everything below uses the dental example; swap the words if you
choose differently — the configuration shape does not change.

### Demo identity — every value fictional 🔵

> Clearly fictional, demo only. Never a real business's name, never a real patient list,
> never copied into `.env.example`.

|                       |                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Business              | **Riverside Dental Care (demo)**                                                          |
| Timezone              | `America/New_York`                                                                        |
| Send window           | `10:00`–`17:00`                                                                           |
| Hourly dispatch limit | `20`                                                                                      |
| Follow-up delay       | `48` hours                                                                                |
| Archive delay         | `7` days                                                                                  |
| Operator tokens       | One `OPERATOR`, one `ADMIN`, generated fresh for the demo and **not** reused from Stage 1 |
| Campaigns             | All `DRAFT` until the moment you rehearse                                                 |

**Demo campaign config** (the `config` object on `POST /api/v1/campaigns` — this is real,
validated shape, not illustration):

```json
{
  "timezone": "America/New_York",
  "sendWindow": { "start": "10:00", "end": "17:00" },
  "hourlyDispatchLimit": 20,
  "followUpDelayHours": 48,
  "archiveDelayDays": 7,
  "messages": {
    "step1": {
      "body": "Hi {{firstName}}, it's {{practice}} — our records show it's been a while since your last visit. Would you like us to find you a check-up time? Reply STOP to opt out.",
      "variables": { "practice": "Riverside Dental Care" },
      "fallbacks": { "firstName": "there" }
    },
    "step2": {
      "body": "Hi {{firstName}}, just closing the loop from {{practice}} — reply any time if you'd like a check-up. Reply STOP to opt out.",
      "variables": { "practice": "Riverside Dental Care" },
      "fallbacks": { "firstName": "there" }
    },
    "replies": {
      "positive": "Great — someone from the practice will text you shortly to get you booked in.",
      "decline": "No problem at all, thanks for letting us know.",
      "clarify": "Sorry for any confusion! This is Riverside Dental Care about a routine check-up. Would you like us to find you a time?",
      "handoff": "Good question — a team member will follow up with the details shortly."
    }
  },
  "qualification": {
    "fields": [
      {
        "key": "wantsCheckup",
        "type": "boolean",
        "description": "DEMO: whether the patient wants to book a check-up",
        "question": "Just to confirm — would you like us to book you a check-up?",
        "requirements": [{ "kind": "equals", "value": true }]
      }
    ]
  }
}
```

**Knowledge items** (`POST /api/v1/knowledge`, ADMIN) — the only source a grounded answer may
use. Three is enough for a demo: opening hours, check-up price, and parking.

### The demo list — fictional contacts, numbers you control ⚠️

**Every number in the demo list must be a handset you personally own or a Twilio-verified
test number.** There is no consent record in this system (Stage 0), and a demo is not an
excuse to message a stranger.

```csv
firstName,lastName,phone,lastServiceDate
Dana,Whitfield,+1555XXXXXXX,2024-03-14
Marcus,Bell,+1555XXXXXXX,2024-01-22
```

Two rows is enough: one that replies positively on camera, one that replies `STOP`.

### Known starting state before every rehearsal

- [ ] A fresh scratch database, or a campaign whose memberships are all `STAGED`
- [ ] Your demo handsets have no leftover threads from the last run
- [ ] No campaign left `ACTIVE` from a previous rehearsal
- [ ] Neither demo number is already suppressed — **check this, because suppression is
      permanent**: `SELECT phone FROM "SuppressionEntry";`
- [ ] Mission Control signed out, so the sign-in moment is on camera

### Checklist

- [ ] Demo campaign created via the real API, config validated (a bad config is refused at creation)
- [ ] Knowledge items loaded
- [ ] Demo CSV imported with `campaignId`, counts read back from `GET /api/v1/imports/:id`
- [ ] Both demo tokens generated fresh
- [ ] Campaign left `DRAFT` until Stage 3 begins

**Do not:** build a second niche yet · use a real practice's name · import any list that is
not your own test numbers · edit frozen source to make the demo look better.

---

<a id="stage-3"></a>

## STAGE 3 — Test the demo yourself 🔴

**Objective:** run the scenes cleanly, twice, before anyone watches. **This stage is
rehearsal. It proves nothing for the first time** — every capability was proven against real
infrastructure in Stage 1.

### Scene A — reactivation ⚠️

| #   | Action                                             | Verify                                                                                  |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Mission Control → sign in as OPERATOR              | Header shows the operator and role                                                      |
| 2   | Start the demo campaign                            | Status `ACTIVE`; the operator activity panel records it                                 |
| 3   | Wait for the scheduler and dispatch ticks (~2 min) | Your handset receives the Step 1 message                                                |
| 4   | Campaign table                                     | `Step 1 sent` = 1, membership `STEP_1_SENT`                                             |
| 5   | Reply "Yes please" from the handset                | Conversation thread shows inbound, classification and the operator reply that went back |
| 6   | Campaign table                                     | Replies = 1, membership `ENGAGED`                                                       |

Narrate the wait; do not speed-edit it away. The one-minute ticks are the honest cadence.

### Scene B — the safety scene, and the strongest thing you have ⚠️

| #   | Action                                             | Verify                                                                     |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | From the second handset, reply something ambiguous | `ReplyProcessing` is `ESCALATED`; **no automated reply is sent**           |
| 2   | Mission Control → Human review                     | The item is there with its reason and confidence                           |
| 3   | Take over the conversation                         | Badge flips to `HUMAN TAKEOVER`; automation for that lead stops            |
| 4   | Resolve the review → **Keep human takeover**       | Review shows resolved, by whom, when; the pause stays                      |
| 5   | From that handset, reply `STOP`                    | Membership `OPTED_OUT`, suppression recorded, nothing further is ever sent |

### Scene C 🟡 — the audit moment, ten seconds

Show the operator activity panel, then run the `UPDATE` from §1.17 in a terminal and let the
database refuse it. "Every operator action is recorded, and the record physically cannot be
edited — not by me, not by the client."

### DEMO READY: YES / NO

- [ ] Scene A completed twice end to end, no stutter
- [ ] Scene B blocks the automated reply and honours `STOP`, twice
- [ ] Mission Control never showed a raw error code or a blank panel
- [ ] Both handsets reset (fresh database or fresh numbers — suppression is permanent)
- [ ] Total runtime under 4 minutes

Any **NO** → classify it (configuration / provider / test data), fix it, re-run the whole
sequence. **Do not record yet.**

**Do not:** debug on camera · show logs, tokens or `.env` · start a campaign whose list is
anything other than your own numbers.

---

<a id="stage-4"></a>

## STAGE 4 — Record the Loom 🔴

**Target: 2–4 minutes.** You are selling an outcome, not a codebase.

### Pre-recording checklist

**Environment**

- [ ] `/health` and `/ready` checked within the last five minutes
- [ ] Both scenes rehearsed today, on this machine
- [ ] Twilio balance sufficient; OpenAI key has credit
- [ ] Fresh scratch database, campaign `DRAFT`, handsets clear
- [ ] Mission Control signed out

**Tabs and windows**

- [ ] Left to right: Mission Control · your phone screen (mirrored or filmed) · a terminal only if you show Scene C
- [ ] Everything else quit, not minimised; OS notifications off
- [ ] Bookmarks hidden, font size up, clean desktop

**Secret safety**

- [ ] No token visible anywhere — including the sign-in field (it is a password input; confirm it masks)
- [ ] `.env` not open in any window
- [ ] No real patient, client or contact data on any screen
- [ ] Every visible name fictional

### Sequence

| Time                       | Screen                  | Say                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0:00–0:20 Hook**         | Your face               | "Every practice has a list of people who came once and never came back. It sits in the system doing nothing, because nobody has time to work through it by hand."                                                                                                                                                                             |
| **0:20–0:40 Before**       | Mission Control, empty  | "The usual options are a bulk blast that annoys everyone, or a receptionist making calls between patients. One damages the brand, the other never happens."                                                                                                                                                                                   |
| **0:40–1:50 Reactivation** | Mission Control → phone | "Here's the same list, worked properly. It goes out inside business hours, at a controlled rate, one message per person — _(start campaign, show the message arrive)_ — and when someone replies, the reply is read and answered from the practice's own approved wording. _(show the reply and response)_ Nobody typed that at 9pm."         |
| **1:50–2:40 Safety** 🔴    | Phone → review queue    | "This is the part I care about. When a reply isn't clear-cut, it does **not** guess — it stops and puts the conversation in front of a person. _(show the review queue, take over)_ And when someone says STOP, that's permanent, immediately, everywhere — _(send STOP, show OPTED_OUT)_ — the system physically cannot message them again." |
| **2:40–3:00 Close**        | Your face               | "Dormant patients get a polite, controlled nudge; anything sensitive reaches a human; and every operator action is recorded permanently. I set it up on your list and your number. If you want to see it on your own data, reply and I'll walk you through it."                                                                               |

**One reliability sentence, maximum:** _"An opt-out is recorded permanently and re-checked
immediately before every single message — I tested that against a real phone before showing
you this."_

**Do not say:** idempotency, pg-boss, Prisma, state machine, "AI agent", frozen phases, test
counts, or any number you have not personally verified.

**Do not show:** code, the repository, `.env`, a token, raw logs, or a booking being
confirmed — **bookings cannot be confirmed today (GAP 3)** and showing a "booking" would be
a lie.

### After recording

- [ ] Watch once muted, checking no token or real number is visible in any frame
- [ ] Watch once with sound — the safety moment must be audible and unhurried
- [ ] Under 4 minutes
- [ ] Screenshots saved: the received message, the review queue, the `OPTED_OUT` state, the audit panel

---

<a id="stage-5"></a>

## STAGE 5 — Package the offer 🔴

Pricing is **[YOU DECIDE]** throughout. This section gives structure and the factors that
usually drive the number; it invents none.

### One-sentence offer

> I take the list of customers who went quiet, message them politely and at a controlled
> rate from your number, hand anything that needs a person straight to your team, and honour
> an opt-out permanently — with every operator action recorded.

### The paragraph

> Most businesses have a database of people who came once and never came back. Working it by
> hand never happens, and a bulk blast damages the brand and risks a complaint. This system
> works that list the way a careful person would: inside business hours, at a rate you set,
> one conversation at a time, from your own number. Replies are read and answered using
> wording you approve. Anything unclear stops and reaches a human. `STOP` is honoured
> permanently, checked again immediately before every message. Every operator action is
> written to an audit trail the database itself will not let anyone edit.

### Pricing — [YOU DECIDE]

| Item                   | Price                    | What usually drives it                                                                                               |
| ---------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Setup / first campaign | **[YOU DECIDE]**         | List size and messiness, how much copy you write for them, whether they have Twilio already, how many campaigns      |
| Ongoing monitoring     | **[YOU DECIDE]**         | Whether you watch the review queue for them, and how fast they expect a human response                               |
| Per-message / usage    | **Pass through at cost** | Twilio charges per segment; OpenAI per reply classified. Do not mark these up silently — show them the provider bill |

Three honest notes to price around:

1. **The client should own the Twilio and OpenAI accounts**, so they see their own spend and
   can revoke access. That removes a margin stream and a liability at the same time.
2. **Reviewing the queue is human work.** If you are the one clearing escalations, that is a
   recurring service, not a setup fee.
3. **Booking is not delivered today** (GAP 3). Do not price a booking outcome.

### Included 🔵

- One deployment, one database, their credentials
- One campaign configured: Step 1 copy, Step 2 copy, reply templates, send window, rate,
  follow-up and archive delays
- Their approved knowledge items for grounded answers
- Their list imported, with the written consent basis on file (Stage 0 / §7.2)
- Operator accounts for their team, with roles
- A walkthrough of Mission Control: review queue, takeover, resolution, campaign controls
- A controlled end-to-end test to your own handset before any real send

### Explicitly excluded — say these out loud

- **Booking into a calendar.** No calendar adapter exists; the system sends a link the
  business supplies and can record a confirmation only once an adapter is built
- **CRM sync, owner notifications, Service 3 handoff** — outbox rows are written and stay
  `BLOCKED` until adapters exist
- Any guarantee of a reactivation rate, revenue, or number of bookings
- Consent collection, list cleaning, or legal advice about their list
- A global kill switch (per-campaign and per-lead stops exist; there is no single switch)

### Five defensible selling points — each demonstrated, none invented

1. Controlled, not a blast: business hours, recipient timezone, a per-campaign hourly limit.
2. Replies are read and answered from the client's own approved wording — never free-form
   model text.
3. Unclear replies stop and reach a human, with a review queue and a resolution trail.
4. `STOP` is permanent, database-enforced, re-checked immediately before every send.
5. Operator actions are recorded in an append-only audit the database refuses to alter.

### Objections

| They say                            | You say                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Isn't this just mass texting?"     | "No. One message per person, inside your hours, at a rate you set, and it stops the moment someone replies or opts out. If you want a blast, there are cheaper tools — I would rather you not use them on this list."                                                                     |
| "Is AI going to text my customers?" | "The model reads replies and drafts nothing on its own. Every message that goes out is wording you approved, or an answer built strictly from facts you gave me. Anything it is unsure about goes to a person."                                                                           |
| "What about compliance?"            | "Opt-outs are permanent and enforced by the database, and I will show you that. The part the software does **not** do is prove consent — that is on your list, which is why I ask you to state in writing where it came from before I import anything. If you cannot, I will not run it." |
| "Can it book appointments?"         | "Not into a calendar today. It sends your booking link and tracks the conversation; a calendar integration is separate work. I would rather tell you that now than demo something that does not exist."                                                                                   |
| "What if it goes wrong at 2am?"     | "Any campaign stops in one click, any conversation stops in one click, and the whole system stops on a restart. There is no single global switch — I will show you exactly what to press."                                                                                                |

---

<a id="stage-6"></a>

## STAGE 6 — Outreach & sales 🔴

Two channels only. No invented statistics — you have no reactivation rate to quote, because
this system has never run on a real list. Say what it _does_, not what it _achieves_.

**A. Cold email** (primary) — practices and businesses with an obvious repeat-visit model:
dental, optical, veterinary, aesthetics, servicing trades. Find them the same way as any
local-business outreach: maps search → website → owner or practice manager contact.

**B. Instagram / LinkedIn DM** (secondary) — short, human, no deck.

### Good prospect if

- [ ] Their business model has natural repeat visits (recall, servicing, renewal)
- [ ] They keep customer records with mobile numbers
- [ ] The records were collected directly from the customer, at intake or purchase
- [ ] Small team — nobody is working the dormant list today
- [ ] English-speaking market, one timezone to start

### Skip without hesitation

- Anyone whose "list" is bought, scraped, or of unknown origin — **Stage 0 makes this a hard
  no, not a negotiation**
- Businesses with no repeat-visit motion
- Anyone who wants a one-off blast to thousands tonight
- Anyone who needs appointments written into a calendar as part of v1 (GAP 3)

### The messages

**1. First cold email** — subject: `the patients who never came back`

> Hi {Name},
>
> Quick question about {business} — how do you currently follow up with people who came once
> and never rebooked?
>
> I build a small system that works through that list properly: one polite text per person,
> inside your hours, from your number, at a rate you set. Replies get read and answered using
> wording you approve, anything unclear goes straight to your team, and an opt-out is
> permanent.
>
> It only works on a list your customers actually gave you — if that's your situation, I can
> send a 3-minute video of it running.
>
> {You}

**2. Follow-up (3 days later)**

> Hi {Name} — floating this up in case it got buried. Want the 3-minute video?

**3. Loom outreach**

> Here's the short version: {loom link}
>
> It's set up for a fictional practice, but the wording and the rules are the kind of thing
> you'd give me: what the first message says, what hours it runs, and what has to reach a
> person instead of being answered automatically.

**4. "How much?"**

> Setup is {YOUR PRICE} and covers the campaign wording, your list, your team's logins and a
> controlled test to my own phone before anything goes to a customer. Twilio and the AI
> provider bill you directly at cost — you own those accounts, so you see the spend and can
> switch it off without me.

**5. "Can it book them in?"**

> Not into a calendar today — I'd rather be straight about that. It sends your booking link
> and keeps the conversation, and your front desk confirms. Calendar integration is separate
> work I'd quote on its own.

**6. "We tried mass texting, it went badly."**

> That's usually the blast problem: everyone at once, no reply handling, no opt-out
> discipline. This is the opposite — one person at a time, inside your hours, with replies
> read and anything unclear handed to your team. And STOP is enforced by the database, not
> by someone remembering.

**7. "Is this legal?"**

> It depends on your list, not on my software. If your customers gave you their number and
> agreed you could contact them, you're on solid ground — and I'll ask you to write down
> where that consent came from before I import anything. If the list was bought or scraped, I
> won't run it.

**8. "Send information"**

> Here's the 3-minute video rather than a PDF — it's faster to see it working: {loom link}.

### Daily target (first two weeks)

|                          | Volume |
| ------------------------ | ------ |
| New prospects researched | 10/day |
| First emails             | 10/day |
| Follow-ups               | 5/day  |
| DMs                      | 5/day  |

Do not change the offer after 20 emails. Reconsider after 80, and only if objections cluster
on one specific thing.

**Do not:** buy lists (you would be doing exactly what you tell prospects not to) · quote a
reactivation percentage · promise bookings.

---

<a id="stage-7"></a>

## STAGE 7 — Client onboarding 🔵

An operator should be able to onboard the first paying client from this section alone.

### 7.1 Collect before you configure

**Business**

| Item                          | Notes                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Display name                  | Appears in every message template                                                                             |
| Timezone                      | IANA, e.g. `America/Chicago` — the send window is evaluated in the recipient's timezone, falling back to this |
| Operating hours for messaging | Becomes `sendWindow`; be conservative                                                                         |
| Who owns replies              | A named person; the review queue is theirs                                                                    |

**The list — and its consent basis 🔴**

| Item                                   | Notes                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the list came from               | Their system of record, exported by them                                                                                                                                                                                                                                                                                              |
| **Written consent statement**          | **Required before any import.** See §7.2                                                                                                                                                                                                                                                                                              |
| Format                                 | CSV with any headers — you map them. Only these fields are read: `firstName`, `lastName`, `phone`, `email`, `source`, `externalId`, `lastServiceDate`, `timezone`                                                                                                                                                                     |
| Phone format                           | E.164 preferred; otherwise set `defaultCountry` on the import                                                                                                                                                                                                                                                                         |
| **Their existing do-not-contact list** | ⚠️ **There is no route or CLI to import suppression entries.** If they have an internal DNC list, it must be applied **before** the import by removing those rows from the CSV, and re-applied to every later import. Write this into the runbook you hand over — it is the single most dangerous manual step in the whole engagement |
| Expected volume                        | Sets `hourlyDispatchLimit` and the Twilio number type                                                                                                                                                                                                                                                                                 |

**Messaging**

| Item            | Notes                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Twilio account  | **Theirs.** They own the number, the spend and the ability to switch it off                                 |
| Sender number   | Local number preferred; A2P 10DLC registration is their responsibility and takes time — start it on day one |
| Step 1 copy     | Theirs, approved in writing. Must identify the business and include opt-out wording                         |
| Step 2 copy     | Same. Sent once, `followUpDelayHours` after Step 1, only if there was no reply                              |
| Reply templates | `positive`, `decline`, `clarify`, `handoff` — fixed text, approved in writing                               |
| Knowledge items | The only facts a grounded answer may use. Approved in writing                                               |

**AI**

| Item                           | Notes                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| OpenAI account                 | **Theirs**, with `OPENAI_MODEL` agreed                                                         |
| Confidence threshold           | `CLASSIFIER_CONFIDENCE_THRESHOLD` — below it, nothing semantic happens and the reply escalates |
| What must always reach a human | Confirm their expectations match what escalation actually does                                 |

**Operators**

| Item              | Notes                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Who gets OPERATOR | Reads, campaign controls, takeover, review resolution                                                                     |
| Who gets ADMIN    | Imports, campaign creation, knowledge writes, delivery requeue                                                            |
| Token handling    | Generated with `npm run operator:token`, handed over once via a password manager or one-time link, never by email or chat |
| Revocation        | Remove the entry and **restart the API** — tell them this before they need it                                             |

**Deployment**

| Item                  | Notes                                                                               |
| --------------------- | ----------------------------------------------------------------------------------- |
| Database              | A dedicated PostgreSQL for this client                                              |
| Hosting               | Any Node ≥ 22.12 host. **No container image exists**                                |
| `WEB_URL` / `API_URL` | Both https in production; `WEB_URL` a bare origin, and the only allowed CORS origin |
| `TRUST_PROXY`         | Number of proxy hops, so rate limiting sees real client IPs                         |
| Webhook URL           | `<API_URL>/api/v1/webhooks/messaging/twilio/inbound` set on their number            |

### 7.2 Client approval — required before you import anything 🔴

In writing, before the first import:

1. **Consent basis and provenance for every list**, naming: the lawful basis, where and when
   consent was captured, the exact wording shown at capture, and the person at the business
   who attests to it. **No statement, no import.**
2. Their existing do-not-contact list, applied to the CSV before it reaches you.
3. Step 1, Step 2 and all four reply templates, verbatim.
4. The knowledge items — the only facts the system may state.
5. Send window, hourly rate, follow-up delay, archive delay.
6. Who owns the review queue and how fast they will clear it.
7. Acknowledgement of what is **not** delivered: no calendar booking, no CRM sync, no owner
   notifications, no global kill switch.

### 7.3 The gated sequence

| #   | Step                  | You produce                                                                                                        | Gate                                                                                                  |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1   | Discovery call        | The §7.1 sheet, complete                                                                                           | You could write the campaign config from what you were told                                           |
| 2   | **Consent statement** | Their written statement, filed                                                                                     | **No statement → stop here**                                                                          |
| 3   | Infrastructure        | Their database, their Twilio, their OpenAI, deployed API and Mission Control                                       | `/health` 200, `/ready` 200                                                                           |
| 4   | Configuration         | Campaign created `DRAFT`, knowledge loaded, operator tokens issued                                                 | Config accepted by the API; both operators can sign in                                                |
| 5   | Controlled test ⚠️    | A one-row list containing **your own handset**, campaign started, message received, reply handled, `STOP` honoured | Everything in §1.12–§1.14, on their infrastructure                                                    |
| 6   | Client review         | They read the live thread from step 5 and the review queue                                                         | Written "yes, that's right"                                                                           |
| 7   | Real list import      | Their approved list, DNC already removed, imported with `campaignId`                                               | Import counts reconciled against their expectation, row by row for anything `INVALID` or `SUPPRESSED` |
| 8   | Pilot batch 🔴        | Start with `hourlyDispatchLimit` low (10–20) and, if you can, a list slice of 50                                   | First replies watched in real time by a human — you and them                                          |
| 9   | Full run              | Raise the rate only after the pilot batch's replies have been read                                                 | No unresolved reviews older than a day                                                                |
| 10  | Monitoring (7 days)   | Daily: review queue, integration health, campaign table                                                            | Queue cleared daily; no surprise in the audit                                                         |
| 11  | Handoff               | Mission Control walkthrough, runbook, named owners                                                                 | They can state what an escalation means and how to stop a campaign                                    |

**Consider running the pilot batch during staffed hours only**, regardless of the send
window. The first real replies from a dormant list are the moment to have a human watching.

### Out of scope

- Calendar booking, CRM sync, owner notifications, Service 3 handoff (GAP 3, GAP 4, GAP 5)
- Importing their do-not-contact list (no route exists — manual CSV hygiene instead)
- Consent collection, list cleaning, or legal advice
- A global kill switch
- Multi-tenancy — one deployment and one database per client
- A container image

---

<a id="stage-8"></a>

## STAGE 8 — First 7 days

| Day   | Focus                                 | Tasks                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | Consent and baseline                  | Read Stage 0 and write down your own position on selling with the consent gap open · §1.1 local baseline · §1.3 migrations against a scratch server · §1.4 configuration refusal cases                                                                 |
| **2** | Credentials — the two BLOCKED gaps 🔴 | Open the Twilio account, buy a number, verify your own handset, start A2P registration (it has a lead time) · create the OpenAI key and choose the model · §1.2 the suite against a managed PostgreSQL                                                 |
| **3** | Boot and access                       | §1.5 boot, `/ready`, the real database-outage 503 and unattended recovery · §1.6 auth, roles, rate limits · §1.7 token issue and revocation · §1.22 the log grep                                                                                       |
| **4** | The UI, by hand                       | §1.8 every Mission Control row including the Enter-key check · §1.10 lifecycle and audit · §1.17 the append-only trigger refusing you                                                                                                                  |
| **5** | **First real messages** ⚠️💵          | §1.11 webhook signatures · §1.12 **first real SMS to your own handset**, guardrails in place · §1.13 **first real classified reply** · §1.14 **a real STOP honoured**                                                                                  |
| **6** | State and stopping                    | §1.15 the state path, booking proven `BLOCKED` · §1.16 takeover and review resolution · §1.18 requeue returns 0 · §1.19 rehearse stopping · §1.21 hosted deployment with workers off · §1.23 the gate, every line honest                               |
| **7** | Demo and launch                       | Confirm the niche (Stage 2) · build the demo campaign and rehearse both scenes twice (Stage 3) · record the Loom, three takes (Stage 4) · settle pricing and write the objection answers (Stage 5) · list 30 prospects and send the first 10 (Stage 6) |

**If day 3, 4 or 5 uncovers a genuine defect**, stop the schedule, classify it, document it,
and do not record a Loom against an unverified build.

---

## Master checklist

### Before declaring environment verification complete

- [ ] **Stage 0 read, and the consent position written down.** No send to anyone but your own handset
- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:secrets`, `npm run format:check` all green — API `42 files / 414 tests`, web `2 files / 15 tests`
- [ ] The suite run once against a managed PostgreSQL over TLS (GAP 6)
- [ ] Eight migrations apply once; a second deploy is a no-op; both append-only triggers exist
- [ ] Every configuration-refusal case refuses, naming the variable, echoing no value
- [ ] `/health` and `/ready` correct, including `jobs`; a real outage returns `503 DATABASE_ERROR` and recovers unattended
- [ ] `401` / `403` / `429` all proven; webhooks exempt from operator auth and rate limiting
- [ ] Mission Control driven by hand end to end, including the Enter-key check
- [ ] One real SMS sent to your own handset, with the one-lead guardrails in place
- [ ] One real reply classified and answered with operator-approved wording
- [ ] One real `STOP` honoured, permanently, and proven to outrank operator action
- [ ] Takeover and review resolution proven, including no-op repeats and the `409` conflict
- [ ] The database refused an `UPDATE` and a `DELETE` on audit and suppression rows, with you watching
- [ ] No secret, full phone number or message body anywhere in the logs
- [ ] A hosted deployment is live with no active campaign
- [ ] Every `BLOCKED` gap recorded as `BLOCKED` — GAP 3, GAP 4, GAP 5 cannot be closed by you alone

### Before demo

- [ ] Niche confirmed
- [ ] Demo campaign, knowledge items and two-row list created through the real API
- [ ] Every demo number is a handset you control, and neither is already suppressed

### Before Loom

- [ ] Both scenes run cleanly twice, today
- [ ] Fresh database or fresh numbers; campaign `DRAFT`; Mission Control signed out
- [ ] No token, `.env`, code or log visible in any frame
- [ ] Nothing in the script claims a booking, a CRM sync or a reactivation rate

### Before taking payment

- [ ] Price decided and written down, with usage costs passed through at cost
- [ ] Scope and exclusions in writing, including the three BLOCKED integrations
- [ ] The consent requirement stated in writing, and the client has agreed to it

### Before client deployment

- [ ] **Written consent statement on file**
- [ ] Their DNC list applied to the CSV before import
- [ ] Their Twilio (A2P registered) and OpenAI accounts, owned by them
- [ ] Isolated database; `WEB_URL` and `API_URL` https; `TRUST_PROXY` set
- [ ] Operator tokens issued and delivered securely; revocation procedure explained

### Before go-live

- [ ] Controlled test to your own handset passed on **their** infrastructure
- [ ] Pilot batch at a low rate, watched live by a human
- [ ] Review queue owner named, with a response-time expectation

### Before handoff

- [ ] They can start, pause and complete a campaign, and take over a conversation
- [ ] They know `STOP` is permanent and cannot be undone
- [ ] They know there is no global kill switch, and what to press instead
- [ ] They know revoking an operator token needs a restart
- [ ] They know bookings, CRM sync and owner notifications are not delivered
- [ ] Your copies of their credentials deleted, and you have told them so

---

## Straight answers

**1. Is serious backend engineering still required?**

Not for what is built. Phases 0–4 are complete and frozen. **One thing that is not built is
load-bearing for the product's legality: consent** (Stage 0). Closing that is a real
engineering phase, and it is the only work of that size still on the table.

**2. What absolutely must be verified before selling?**

Everything in _Before declaring environment verification complete_, on your own scratch
infrastructure: the suite against a managed database, migrations and both append-only
triggers, every configuration refusal, auth and roles, the real 503 outage path, Mission
Control by hand, one real SMS to your own phone, one real classified reply, one real `STOP`
honoured, and the audit trigger refusing you personally.

**3. What can safely wait for the first client?**

Their copy, their knowledge items, their list, their Twilio and OpenAI accounts, and their
operator accounts. None of it blocks Stage 1.

**4. What is the strongest happy-path demo?**

Scene A: a dormant contact gets one polite, business-hours message from the client's own
number, replies, and the reply is answered with the client's own approved wording.

**5. What is the strongest safety demo?**

Scene B, then Scene C: an unclear reply that is _not_ answered automatically but handed to a
person, a `STOP` that is honoured permanently, and an audit row the database itself refuses
to let you edit.

**6. What should I never promise?**

A reactivation rate, revenue, a number of bookings, calendar booking, CRM sync, owner
notifications, a global kill switch, or that the system checks consent. None of those are
true today.

**7. What is genuinely blocked, and by whom?**

GAP 1 (Twilio) and GAP 2 (OpenAI) are blocked on _you_ opening accounts — a day's work.
GAP 3 (calendar), GAP 4 (CRM / notifications / handoff) and GAP 5 (Service 3, waiting on the
Google Review Agent) are blocked on **a vendor decision you have not made**, and each needs
an adapter built afterwards. Do not sell any of them.

**8. Can I sell this before the consent gap is closed?**

Only with the containment in Stage 0: a written consent statement from the client for every
list, your refusal to import anything unattested, and honesty on the call that the software
does not check consent — the list does. If you are not prepared to enforce that, close the
gap first.

**9. What does the client need to provide?**

A list with a written consent basis and their DNC removed, their message copy and knowledge
items approved in writing, their own Twilio (A2P registered) and OpenAI accounts, a named
owner for the review queue, and their operating hours.

**10. Which credentials should the client own?**

Twilio and OpenAI, on their own accounts, so they see the spend and can revoke. You generate
operator tokens and hand them over once.

**11. What is explicitly out of scope?**

Calendar booking, CRM sync, owner notifications, the Service 3 handoff, importing a
suppression list, consent capture, multi-tenancy, a container image, and a global kill
switch.

**12. What should I do first tomorrow?**

Open the Twilio account, buy a number, verify your own handset, and start A2P registration —
it has the longest lead time of anything here. Then create the OpenAI key. Those two
credentials unblock §1.12–§1.14, which are the only steps that prove this product does what
its name says.

**13. When is environment verification officially complete?**

When every line of [§1.23](#123-final-stage-1-audit--the-gate) is honestly `PASS`, `BLOCKED`
or `NOT APPLICABLE`, with the `BLOCKED` ones named in writing — not before.

**14. What happens if verification discovers a real defect?**

Stop. Write down the exact input, the observed behaviour, the invariant it violates and the
reproduction path. Describe it to the user before touching frozen code, then follow the
freeze policy in [CLAUDE.md](../CLAUDE.md): smallest safe fix, a deterministic test, lint,
typecheck, the whole suite and the build re-run. Everything not downstream of the defect can
still be verified while the fix is pending.
