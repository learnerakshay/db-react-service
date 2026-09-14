# CLAUDE.md — Cadentor Service 4

## Project identity

**Cadentor — Service 4: Dormant Lead & Database Reactivation Engine**

Ingests historical, never-converted leads; cleans and validates them; suppresses
prohibited contacts; re-engages eligible leads through rate-controlled messaging;
interprets replies; answers grounded questions; qualifies; books; syncs to CRM;
notifies the owner; and reports everything with an audit trail.

This file governs all Claude Code work in this repository. Read it before every task.

## Phase registry

| Phase                                                   | Status                              |
| ------------------------------------------------------- | ----------------------------------- |
| PHASE 0 — Foundation                                    | COMPLETE — awaiting freeze sign-off |
| PHASE 1 — Data Pipeline + Campaign Queue                | NOT STARTED                         |
| PHASE 2 — Messaging + Reply Intelligence                | NOT STARTED                         |
| PHASE 3 — Conversion / Booking + Operational Automation | NOT STARTED                         |
| PHASE 4 — Mission Control + Production Hardening        | NOT STARTED                         |
| ENVIRONMENT VERIFICATION                                | NOT STARTED                         |
| DEMO / PROOF                                            | NOT STARTED                         |
| CLIENT DEPLOYMENT                                       | NOT STARTED                         |

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

## Async / jobs policy

- Durable work goes through the `JobQueue` interface (`apps/api/src/jobs/queue.ts`).
  Planned adapter: pg-boss on PostgreSQL. Do not add Redis without a proven need.
- Handlers must be idempotent; retries must be bounded; failures must be logged
  with `jobId` and surfaced, never swallowed.

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
  never the development database.
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
npm run db:migrate   # prisma migrate dev (requires DATABASE_URL)
```
