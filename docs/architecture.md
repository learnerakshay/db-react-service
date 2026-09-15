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
- **Jobs** (`src/jobs/`): `JobQueue` interface (`queue.ts`) implemented with
  pg-boss (`boss.ts`); `campaign-scheduler.ts` holds job names, queue
  definitions, the minute tick and worker registration; `workers/` holds job
  handlers. Started by `server.ts` only when `JOB_WORKERS_ENABLED=true`.
- **Modules** (`src/modules/`): one directory per capability.
  - `leads/` — phone (libphonenumber) and email normalization, canonical lead
    input, lead resolution and merge rules.
  - `suppression/` — global append-only suppression list.
  - `campaigns/` — campaign creation, config snapshot, membership staging and
    the CampaignLead transition map.
  - `imports/` — canonical ingestion service, CSV adapter, batch lifecycle.

## Operational automation (Phase 3 / Prompt 2)

```text
operations-tick (pg-boss cron)
  ├── followup/step2.ts      findStep2Candidates → outbound-step2-send → sendStep2Message
  ├── followup/archival.ts   archiveDueMembers (transition service, under lock)
  └── integrations/deliveries.ts  findDueDeliveries → integration-delivery
                                  → CrmProvider | NotificationProvider | PostBookingHandoffProvider

booking-events.ts (verified event) → IntegrationDelivery rows in the same transaction
providers/integrations.ts: no CRM / notification / Service 3 adapter → BLOCKED deliveries

replies/processor.ts → conversion/outstanding.ts → router: QUALIFICATION_ANSWER
```

## Qualification + booking (Phase 3 / Prompt 1)

```text
conversion-tick → qualification-process (per inbound message of an ENGAGED member)
  → modules/conversion/qualification.ts
      eligibility (no AI) → extraction.ts (AiProvider → strict Zod + evidence check)
      facts.ts (precedence) → evaluator.ts (pure rules → result)
      apply: evaluation, question | archive | QUALIFIED + booking.ts offer
  → modules/conversion/sender.ts → MessagingProvider (same guarantees as replies)

POST /api/v1/webhooks/calendar/:provider   (signature first; mounted only with a calendar adapter)
  → modules/conversion/booking-events.ts   idempotent; the only path to BOOKED

providers/calendar/index.ts (contract; no adapter — no vendor selected)
providers/calendar/registry.ts (CALENDAR_PROVIDER set → startup error)
```

## Reply intelligence (Phase 2 / Prompt 2)

```text
inbound webhook → reply-process job (also reply-processing-tick safety net)
  → modules/replies/processor.ts
      claim (ReplyProcessing, UNIQUE per inbound message)
      safety gate (exact STOP, stale, suppressed)        no AI
      context.ts      bounded same-conversation history
      classifier.ts   AiProvider → Zod-validated IntentAnalysis
      router.ts       deterministic action
      knowledge/retrieval.ts + grounding.ts   approved facts → validated answer
      apply           suppression / transitions / PENDING reply (one transaction)
  → modules/replies/reply-sender.ts → MessagingProvider (same guarantees as Step 1)

providers/ai/index.ts (contract) → providers/ai/openai.ts (only OpenAI importer)
POST/GET /api/v1/knowledge, POST /api/v1/knowledge/:id/deactivate
```

## Messaging (Phase 2 / Prompt 1)

```text
pg-boss outbound-dispatch-tick → outbound-step1-send (per QUEUED member)
  → modules/messaging/outbound.ts   lock, final safety checks, claim, send, record
  → providers/messaging/index.ts    MessagingProvider contract
  → providers/messaging/twilio.ts   Twilio SDK (only importer)

POST /api/v1/webhooks/messaging/:provider/inbound   (raw form body, signature first)
  → modules/messaging/inbound.ts    idempotent insert, lead/campaign resolution, hard opt-out
POST /api/v1/webhooks/messaging/:provider/status
  → modules/messaging/delivery.ts   idempotent, forward-only Message status
```

Webhook routes exist only when `SMS_PROVIDER` is configured. Signatures are
verified against `API_URL` + the request path, so `API_URL` must be the public
URL the provider calls.

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
