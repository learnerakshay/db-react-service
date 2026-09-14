# Architecture — Phase 0 baseline

## Components

| Unit              | Responsibility                                                    |
| ----------------- | ----------------------------------------------------------------- |
| `apps/api`        | REST API, future domain services, jobs and provider adapters      |
| `apps/web`        | Operator UI (placeholder in Phase 0)                              |
| `packages/shared` | Contracts used by both apps: error codes, error body, system DTOs |
| `prisma/`         | Schema and migrations for the single PostgreSQL database          |

npm workspaces tie them together. `packages/shared` is compiled to `dist/` (on
install, build, test and in `dev` watch mode) so both Node and Vite consume plain
ESM plus declarations.

## API request path

```text
request
  → pino-http        request ID (x-request-id), one structured log line per request
  → helmet           security headers
  → cors             only WEB_URL
  → express.json     100kb limit
  → routes           validate input, call a service, shape response
  → notFoundHandler
  → errorHandler     AppError → ApiErrorBody; unknown → INTERNAL_ERROR; no leaks
```

`createApp()` (app.ts) builds this pipeline from injected dependencies and has no
process side effects, so tests exercise the real middleware stack with fakes.
`server.ts` owns everything process-level: loading `.env`, validating config,
creating the Prisma client, listening, and graceful shutdown (stop accepting
connections → future job queue stop → database disconnect → exit, with a 10s
force-exit timer).

## Configuration

`config/env.ts` validates raw variables with Zod (blank = unset, coercion,
production-only requirements, cross-field checks). `config/index.ts` maps them to
`AppConfig`, grouped by concern: `http`, `database`, `providers`, `campaign`,
`classifier`. Future-phase values are typed and defaulted now so later phases add
behavior without reshaping configuration.

## Boundaries prepared for later phases

- **Providers** (`src/providers/*`): provisional interfaces for messaging, AI,
  calendar, CRM, notifications. No adapters.
- **Jobs** (`src/jobs/queue.ts`): `JobQueue` interface with idempotency keys,
  delayed start and bounded retries — shaped to fit pg-boss. No implementation.
- **Modules** (`src/modules/`): one directory per capability.
  - `leads/` — phone (libphonenumber) and email normalization, canonical lead
    input, lead resolution and merge rules.
  - `suppression/` — global append-only suppression list.
  - `campaigns/` — campaign creation, config snapshot, membership staging and
    the CampaignLead transition map.
  - `imports/` — canonical ingestion service, CSV adapter, batch lifecycle.

## Ingestion (Phase 1 / Prompt 1)

```text
POST /api/v1/imports/csv (multipart)
  → lib/upload.ts            stream to temp file, SHA-256, size limit
  → imports/csv.ts           full syntax check, header mapping, streamed rows
  → imports/ingestion.ts     normalize → dedupe → suppression → resolve lead
                             → stage → record outcome   (chunked transactions)
  → imports/batches.ts       batch lifecycle, summary + issues
GET  /api/v1/imports/:id
POST /api/v1/campaigns
```

Adapters (CSV today; CRM/Sheets later) only map their source into canonical
`SourceRow`s. All hygiene rules live in the ingestion service. Details and
guarantees: [database.md](database.md).

## Error model

| Class                  | Code                  | HTTP | Message returned to client |
| ---------------------- | --------------------- | ---- | -------------------------- |
| `ValidationError`      | `VALIDATION_ERROR`    | 400  | yes (+ issues)             |
| `NotFoundError`        | `NOT_FOUND`           | 404  | yes                        |
| `ConflictError`        | `CONFLICT`            | 409  | yes                        |
| `PayloadTooLargeError` | `PAYLOAD_TOO_LARGE`   | 413  | yes                        |
| `ProviderError`        | `PROVIDER_ERROR`      | 502  | generic                    |
| `ConfigurationError`   | `CONFIGURATION_ERROR` | 500  | generic                    |
| `DatabaseError`        | `DATABASE_ERROR`      | 503  | generic                    |
| anything else          | `INTERNAL_ERROR`      | 500  | generic                    |

## Deliberately absent

Redis, a router in the web app, an ORM repository layer, DI containers, and any
domain schema. Each is added only when a phase proves the need.
