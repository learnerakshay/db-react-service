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
