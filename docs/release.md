# Release readiness — Cadentor Service 4

Engineering build complete after Phase 4 / Prompt 2. This document is the
hand-off for real-environment verification and deployment. It lists what the
system needs, how to run it, and what still depends on external providers.

## 1. Required infrastructure

| Component          | Required                    | Notes                                                                                              |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------------------------- |
| PostgreSQL 16+     | Yes                         | Prisma tables in `public`, pg-boss tables in `pgboss`. Migrations via `npm run db:deploy`.         |
| Node.js ≥ 22.12    | Yes                         | One or more API processes. At least one with `JOB_WORKERS_ENABLED=true`.                           |
| HTTPS termination  | Yes (production)            | `API_URL` and `WEB_URL` must be `https://`. Set `TRUST_PROXY` to the number of proxy hops.         |
| Static web hosting | Yes                         | `apps/web/dist` from `npm run build`, built with `API_URL` pointing at the public API.             |
| Twilio             | For messaging               | Unset = no outbound SMS, no messaging webhooks.                                                    |
| OpenAI             | For reply intelligence      | Unset = inbound replies stored but not classified or answered.                                     |
| Calendar provider  | For verified bookings       | **No adapter exists.** A value in `CALENDAR_PROVIDER` stops startup. Bookings cannot be confirmed. |
| CRM / owner notify | For post-booking outbox     | **No adapters exist.** Deliveries become `BLOCKED` (`NOT_CONFIGURED`) until an adapter is added.   |
| Service 3 handoff  | For post-booking enrollment | **No adapter exists.** Same as CRM.                                                                |

## 2. Configuration

`.env.example` documents every variable. Production startup fails, naming each
invalid key without echoing values, when:

- `DATABASE_URL`, `WEB_URL` or `OPERATOR_TOKENS` is missing;
- `API_URL` or `WEB_URL` is not `https://`, or `WEB_URL` is not a bare origin;
- `OPERATOR_TOKENS` is malformed, has duplicate ids or shared tokens;
- `SMS_PROVIDER` is set without `SMS_ACCOUNT_ID` (valid Twilio SID), `SMS_AUTH_TOKEN`
  and `SMS_FROM_NUMBER`;
- `OPENAI_API_KEY` is set without `OPENAI_MODEL`;
- `CALENDAR_PROVIDER`, `CRM_PROVIDER` or `OWNER_NOTIFICATION_PROVIDER` names a
  provider with no adapter.

Disabled providers need no credentials.

## 3. Operator access

1. Generate one token per person: `npm run operator:token -- <id> <OPERATOR|ADMIN>`.
2. Put the printed `id:ROLE:sha256` entries, comma-separated, in `OPERATOR_TOKENS`
   (secret manager). Give each raw token to its operator once, over a secure channel.
3. Revoke or rotate: remove or replace the entry and restart the API processes.

Roles: OPERATOR reads everything and runs campaign lifecycle, takeover and review
resolution. ADMIN additionally creates campaigns, imports CSVs, edits knowledge
and requeues blocked deliveries. See `docs/mission-control.md` for the full matrix.

## 4. Deploy

```bash
npm ci
npm run db:deploy          # apply committed migrations (review hand-written invariants: docs/database.md)
npm run build              # shared → api → web
npm run start              # API; JOB_WORKERS_ENABLED=true on at least one instance
```

Probes (never authenticated):

- `GET /health` — liveness; process only.
- `GET /ready` — `200` when the database is up and the job queue is `up` (or
  `not_configured` on API-only instances). `503` otherwise. Response exposes only
  `up` / `down` / `not_configured`.

## 5. Security controls

- Operator bearer tokens (hash-only config, constant-time compare), roles, `401`/`403`.
- Rate limits: 10 invalid tokens per client IP per 15 minutes (then `429` for the
  window), 60 mutations per operator per minute. In-memory per process.
- Helmet headers (HSTS, nosniff, frame protection), CORS allowlist of exactly `WEB_URL`.
- JSON body limit 100 KB; malformed JSON and invalid input return `400`.
- Webhooks: provider signature verified over the raw body before any parsing or
  side effect; body limit 64 KB; idempotency via `ProviderWebhookEvent` /
  `CalendarWebhookEvent`; not rate limited so provider retries are never refused.
- Error bodies: `{ error: { code, message, requestId } }`; no stack traces, SQL,
  hostnames or vendor messages. Database unreachable → `503 DATABASE_ERROR`.
- Logs: pino JSON with `requestId`, `campaignId`, `leadId`, `messageId`, `jobId`,
  `deliveryId`, `operatorId`, `operation`, `status`, `errorCode`. Authorization
  headers and credential-like keys are redacted; no message bodies or full contacts.

## 6. Runbooks

| Situation                      | Action                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lead needs a human             | Mission Control → Conversations → Take over. Resume later (resolves the lead's open reviews).                                                    |
| Review queue                   | Human review → Resolve: resume automation, keep takeover, archive, or mark handled. History and audit are kept.                                  |
| New CRM/notification provider  | Deploy its adapter and config, then ADMIN → Integration health → Requeue blocked deliveries. Failed deliveries are never requeued automatically. |
| `/ready` 503, `database: down` | Restore PostgreSQL connectivity. API returns `503 DATABASE_ERROR`; jobs resume from the database when it returns.                                |
| Delivery `FAILED`              | Inspect `lastErrorCode` in Integration health; failures are permanent by design and need a code/config fix.                                      |
| Message `UNCERTAIN`            | Never resent automatically. Check the provider console before any manual follow-up.                                                              |
| Operator audit                 | Overview → Operator activity, or `GET /api/v1/audit`. Rows cannot be edited or deleted.                                                          |

## 7. Environment verification checklist

Run against the real environment before any demo. Each item needs evidence.

1. `npm run db:deploy` applies all migrations; `npm run db:status` reports up to date.
2. `/health` 200, `/ready` 200 with `database: up`, `jobs: up`.
3. Sign in with an OPERATOR and an ADMIN token; confirm a wrong token is refused and
   ADMIN-only actions return 403 for OPERATOR.
4. Twilio: send Step 1 to a test handset inside the send window; confirm `ACCEPTED`,
   delivery callbacks (signature verified) and an inbound reply stored once.
5. `STOP` from the handset creates suppression and `OPTED_OUT`; no further sends.
6. OpenAI: a positive reply is classified and answered with the configured text; a
   low-confidence reply lands in Human review; resolve it.
7. Qualification: answers produce facts, evaluation and the booking link message.
8. Calendar: **BLOCKED until a calendar adapter is built and configured.**
9. CRM / owner notification / Service 3: **BLOCKED until adapters exist**; deliveries
   show `BLOCKED` (`NOT_CONFIGURED`) in Integration health.
10. Step 2 and archival: with shortened campaign delays, confirm closeout and archival.
11. Restart the API during activity; confirm no duplicate sends and jobs resume.

## 8. Known limits

- Rate limiting is per process (N instances allow N× the limit).
- Operator identity is token-based; there is no password reset, SSO or session list.
  Revocation takes effect on restart.
- Conversation listing scans messages per page (fine at single-business volume).
- No calendar, CRM, notification or Service 3 adapter exists; those flows are verified
  only with test doubles.
