# Cadentor — Service 4: Dormant Lead & Database Reactivation Engine

> **Current status: PHASE 2 — MESSAGING + REPLY INTELLIGENCE**
> Lead ingestion, suppression, campaign scheduling and throttling, Step 1 SMS through
> Twilio, signed webhooks, intent classification, grounded answers from approved
> knowledge and human escalation are implemented. Booking and CRM are not.

## Purpose

Businesses accumulate leads that never converted. This service will ingest those
historical leads, clean and validate them, suppress prohibited contacts, re-engage
eligible leads through controlled messaging, interpret replies, answer grounded
questions, qualify and book prospects, update operational systems, and give
operators full visibility and an audit trail.

Planned flow (future phases):

```text
Lead Sources → Ingestion + Hygiene → Suppression Validation → Campaign Queue
→ Rate-Controlled Outreach → Inbound Messaging → Intent Classification
→ Deterministic Action Router → Qualification / Questions / Opt-Out / Escalation
→ Booking → CRM + Notifications → Reporting / Audit Trail
```

## Repository layout

```text
apps/
  api/                 Express + TypeScript REST API
    src/
      config/          Zod-validated environment → typed AppConfig
      db/              Prisma client construction + health check
      generated/       Prisma client output (generated, git-ignored)
      jobs/            Durable job queue interface (pg-boss planned)
      lib/             Logger, application errors, multipart upload
      middleware/      Request ID/logging, error handling
      modules/         Domain modules: leads, suppression, campaigns, imports
      providers/       Provider interfaces: messaging, ai, calendar, crm, notifications
      routes/          HTTP routes (/health, /ready, /api/v1/*)
      types/           Backend-only ambient types
      app.ts           Express app factory (testable, no side effects)
      server.ts        Process entrypoint: config, listen, graceful shutdown
    tests/
  web/                 React + Vite + Tailwind operator UI
    src/
      components/      ErrorBoundary, loading/error presentation
      features/        Feature UI (Phase 1+)
      hooks/           useAsync loading/error convention
      lib/             Config + API client boundary
      pages/           Placeholder home page
      main.tsx
    tests/
packages/
  shared/              API contracts shared by api and web (types only)
prisma/
  schema.prisma        Lead, Campaign, CampaignLead, SuppressionEntry, ImportBatch, ImportRowResult
  migrations/          Committed SQL migrations (includes hand-written invariants)
prisma.config.ts       Prisma CLI config (schema, migrations, DATABASE_URL)
docs/                  Architecture and database notes
scripts/               Secret scan, local development PostgreSQL
CLAUDE.md              Engineering rules for Claude Code sessions
```

## Prerequisites

- Node.js **22.12+** (developed on Node 24) and npm 10+
- PostgreSQL **14+** (only needed for database-backed checks; the API starts without it in development)

## Local setup

```bash
npm install
```

`npm install` also builds `packages/shared` and runs `prisma generate`.

### Environment

Copy the template and fill in what you need:

```bash
cp .env.example .env
```

There is one `.env` at the repository root, used by the API, the Prisma CLI and
(for `API_URL` only) the web app.

| Category     | Variables                                                                                                                                                                                           | Needed in Phase 0                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Runtime      | `NODE_ENV`, `LOG_LEVEL`                                                                                                                                                                             | Optional (defaults)                               |
| Database     | `DATABASE_URL`                                                                                                                                                                                      | Optional in dev, **required** in production       |
| HTTP         | `API_PORT`, `WEB_URL`, `API_URL`                                                                                                                                                                    | Optional in dev; `WEB_URL` required in production |
| AI           | `OPENAI_API_KEY`                                                                                                                                                                                    | No (Phase 2)                                      |
| Messaging    | `SMS_PROVIDER`, `SMS_ACCOUNT_ID`, `SMS_AUTH_TOKEN`, `SMS_FROM_NUMBER`                                                                                                                               | No (Phase 2)                                      |
| Integrations | `CALENDAR_PROVIDER`, `CRM_PROVIDER`, `OWNER_NOTIFICATION_PROVIDER`                                                                                                                                  | No (Phase 3)                                      |
| Campaign ops | `DEFAULT_CAMPAIGN_TIMEZONE`, `CAMPAIGN_SEND_WINDOW_START/END`, `CAMPAIGN_HOURLY_DISPATCH_LIMIT`, `CAMPAIGN_FOLLOW_UP_DELAY_HOURS`, `CAMPAIGN_ARCHIVE_DELAY_DAYS`, `CLASSIFIER_CONFIDENCE_THRESHOLD` | No (validated with defaults)                      |

Invalid values stop the API at startup with a message naming each bad key
(values are never printed).

### Database

Use any PostgreSQL 14+ server, or start a local one without Docker:

```bash
npm run db:local        # PostgreSQL on localhost:54329, database cadentor_dev
# in .env: DATABASE_URL=postgresql://USER:PASSWORD@localhost:54329/cadentor_dev
npm run db:migrate
```

Check connectivity with `GET http://localhost:4000/ready` (`200` when the database
answers, `503` otherwise). See [docs/database.md](docs/database.md) for the
migration workflow and test-database strategy.

## Development

```bash
npm run dev             # shared contracts (watch) + API on :4000 + web on :5173
npm run build           # production builds: shared → api → web
npm run start           # run the built API
npm run lint
npm run typecheck
npm run format          # prettier --write
npm run check:secrets   # fail if secrets or .env files would be committed
```

Endpoints:

- `GET /health` — liveness (process only)
- `GET /ready` — readiness (database reachable)
- `POST /api/v1/campaigns` — create a DRAFT campaign (`{ "name": "...", "config"?: {...} }`)
- `POST /api/v1/imports/csv` — multipart upload: `file` (required), `source`,
  `defaultCountry` (ISO alpha-2, needed for national-format phones), `campaignId`,
  `mapping` (JSON, canonical field → CSV header)
- `GET /api/v1/imports/:id` — import summary with per-row issues
- `GET /api/v1/campaigns/:id` — status, config, member counts per status, hourly usage
- `POST /api/v1/campaigns/:id/start | pause | resume | complete` — lifecycle actions
- `POST /api/v1/webhooks/messaging/twilio/inbound` — Twilio inbound SMS (signed)
- `POST /api/v1/webhooks/messaging/twilio/status` — Twilio delivery callbacks (signed)
- `POST /api/v1/knowledge` — add an approved business fact
  (`{ "campaignId"?: uuid, "category": "PRICING", "content": "...", "keywords"?: [...] }`)
- `GET /api/v1/knowledge?campaignId=` · `POST /api/v1/knowledge/:id/deactivate`

Automated replies need `OPENAI_API_KEY` and `OPENAI_MODEL`, plus reply texts per
campaign: `"messages": { "replies": { "positive": "...", "decline": "...", "clarify": "...", "handoff": "..." } }`.
Questions are answered only from approved knowledge; anything uncertain is
escalated for human review.

Step 1 copy is set per campaign at creation, e.g.
`"config": { "messages": { "step1": { "body": "Hey {{firstName}}, are you still looking to {{outcome}}?", "variables": { "outcome": "get your gutters cleaned" }, "fallbacks": { "firstName": "there" } } } }`.
Outbound sending requires `SMS_PROVIDER=twilio` with `SMS_ACCOUNT_ID`,
`SMS_AUTH_TOKEN`, `SMS_FROM_NUMBER`, and `API_URL` set to the public URL Twilio
calls.

Background jobs (pg-boss, same PostgreSQL) start with the API unless
`JOB_WORKERS_ENABLED=false`. Every minute the scheduler admits eligible
members of ACTIVE campaigns to `QUEUED`. Nothing is sent until Phase 2.

```bash
curl -F file=@leads.csv -F defaultCountry=US http://localhost:4000/api/v1/imports/csv
```

## Tests

```bash
npm run test            # all workspaces
npm run test -w @cadentor/api
npm run test -w @cadentor/web
```

## Status

**PHASE 0 — FOUNDATION:** complete, verified, frozen.
**PHASE 1 / PROMPT 1 — DATA FOUNDATION + INGESTION:** complete, verified, frozen.
**PHASE 1 / PROMPT 2 — CAMPAIGN QUEUE + THROTTLING:** complete, verified, frozen.
**PHASE 2 / PROMPT 1 — MESSAGING + WEBHOOK FOUNDATION:** complete, verified, frozen.
**PHASE 2 / PROMPT 2 — REPLY INTELLIGENCE:** complete, awaiting freeze sign-off.
Next: **PHASE 3 / PROMPT 1 — Qualification + Booking Conversion Engine.**
See [CLAUDE.md](CLAUDE.md) for the phase registry.
#   d b - r e a c t - s e r v i c e 
 
 
