# Mission Control

Operator console in `apps/web` over read models in `apps/api/src/modules/dashboard/`
(Phase 4 / Prompt 1), with operator access, human review resolution and audit
(Phase 4 / Prompt 2). Every number is computed server-side from database state.
The web app never derives metrics, never assumes a state change, and shows
backend errors as returned.

## Access

Every `/api/v1` route except webhooks requires `Authorization: Bearer <token>`,
matched against the SHA-256 hashes in `OPERATOR_TOKENS` (`modules/auth/operators.ts`,
`middleware/auth.ts`). `/health` and `/ready` are never authenticated. Webhooks use
provider signatures only.

| Capability                                                      | Role      |
| --------------------------------------------------------------- | --------- |
| Read dashboard, campaigns, conversations, reviews, leads, audit | OPERATOR+ |
| Campaign start / pause / resume / complete                      | OPERATOR+ |
| Human takeover / resume automation                              | OPERATOR+ |
| Resolve human reviews                                           | OPERATOR+ |
| Create campaigns, CSV imports, knowledge writes                 | ADMIN     |
| Requeue blocked integration deliveries                          | ADMIN     |

`401 UNAUTHORIZED` = no valid token. `403 FORBIDDEN` = valid token, insufficient role.
`429 RATE_LIMITED` = too many invalid tokens from one client IP (10 per 15 min, then
blocked for the window, even with a valid token) or too many mutations from one
operator (60 per minute). Limits are per API process.

## Metric definitions

Source: `getOverviewMetrics` and `getCampaignMetrics` in
`apps/api/src/modules/dashboard/metrics.ts`.

"Accepted outbound" means `Message.direction = OUTBOUND` and
`status IN (ACCEPTED, SENT, DELIVERED)`: the SMS provider took the message.
`PENDING`, `SENDING`, `FAILED`, `CANCELLED` and `UNCERTAIN` are never counted as sent.

| Metric              | Definition                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total ingested      | `COUNT(Lead)`. Leads are created only by imports, one per unique E.164 phone; duplicate, invalid and suppressed rows never create a lead.                                              |
| Outbound sent       | Count of accepted outbound messages (all purposes).                                                                                                                                    |
| Contacted leads     | Distinct `leadId` with at least one accepted outbound message.                                                                                                                         |
| Replied leads       | Contacted leads with an `INBOUND` message created after their first accepted outbound (`COALESCE(acceptedAt, createdAt)`).                                                             |
| Reply rate          | Replied leads ÷ contacted leads. `null` when nobody was contacted.                                                                                                                     |
| Positive intent     | Distinct `ReplyProcessing.leadId` with `classification = POSITIVE_INTEREST` and `confidence >= CLASSIFIER_CONFIDENCE_THRESHOLD`. Classifications are stored only after Zod validation. |
| Qualified           | `CampaignLead` rows currently `QUALIFIED` or `BOOKED`, or with a `QualificationEvaluation.result = QUALIFIED` on record (so later opt-outs or cancellations still count).              |
| Appointments booked | `BookingOpportunity.status = CONFIRMED` with `confirmedAt` set. Only `applyBookingEvent` sets this, from a verified calendar event. A sent booking link is `OFFERED`.                  |
| Active campaigns    | `Campaign.status = ACTIVE`.                                                                                                                                                            |
| Human reviews       | Open reviews: `ReplyProcessing.status = ESCALATED` and `reviewResolvedAt IS NULL`.                                                                                                     |
| Opt-out rate        | Contacted leads with any `OPTED_OUT` membership ÷ contacted leads.                                                                                                                     |

Per campaign (`GET /api/v1/dashboard/campaigns`, `GET /api/v1/campaigns/:id/overview`):
membership counts by status; Step 1 sent = accepted `CAMPAIGN_STEP_1`; replies =
distinct leads with an inbound message matched to the campaign (only `MATCHED`
inbound messages carry a `campaignId`); qualified and booked as above, scoped to
the campaign's memberships; hourly usage = `DispatchAdmission` rows in the rolling
hour; last activity = latest message for the campaign.

Recovered revenue is not reported: there is no auditable revenue model.

## API

All routes are under `/api/v1`. List endpoints take `page` (≥ 1) and `pageSize`
(1–100, default 25) and use a stable order with an id tiebreak. GET routes never write.

| Route                                               | Role      | Purpose                                                                                                                  |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /auth/me`                                      | OPERATOR+ | The signed-in operator (`id`, `role`)                                                                                    |
| `GET /dashboard/overview`                           | OPERATOR+ | KPI metrics above                                                                                                        |
| `GET /dashboard/campaigns?status=`                  | OPERATOR+ | Campaign table (newest first)                                                                                            |
| `GET /campaigns/:id/overview`                       | OPERATOR+ | Campaign summary, metrics, dispatch capacity, recent activity                                                            |
| `POST /campaigns/:id/{start,pause,resume,complete}` | OPERATOR+ | Lifecycle actions (`applyCampaignAction`), audited                                                                       |
| `POST /campaigns`                                   | ADMIN     | Create a DRAFT campaign                                                                                                  |
| `GET /conversations?filter=&campaignId=`            | OPERATOR+ | One row per lead with messages, newest message first. `filter`: `all`, `attention` (open review or takeover), `takeover` |
| `GET /conversations/:leadId`                        | OPERATOR+ | Latest 200 messages, oldest first, with routed reply outcome, qualification result and booking status                    |
| `GET /reviews?state=&reason=&campaignId=`           | OPERATOR+ | `state=OPEN` (default) or `RESOLVED` escalations, newest first. Viewing never resolves                                   |
| `POST /reviews/:id/resolve`                         | OPERATOR+ | `{ resolution, note? }`, see below                                                                                       |
| `GET /leads/:id`                                    | OPERATOR+ | Identity, suppression, takeover state, memberships with facts, latest evaluation, bookings, deliveries                   |
| `POST /leads/:id/takeover`                          | OPERATOR+ | Start human takeover (audited when it changes state)                                                                     |
| `POST /leads/:id/resume-automation`                 | OPERATOR+ | End takeover and resolve the lead's open reviews as `RESUME_AUTOMATION`                                                  |
| `GET /audit?targetType=&targetId=`                  | OPERATOR+ | Operator audit events, newest first                                                                                      |
| `GET /integrations/health`                          | OPERATOR+ | Delivery counts per destination, calendar event counts, recent FAILED/RETRY/BLOCKED rows                                 |
| `POST /integrations/requeue-blocked`                | ADMIN     | Requeue `BLOCKED` + `NOT_CONFIGURED` deliveries of now-configured destinations                                           |

Responses never include AI request ids, model names, knowledge item ids, rules
snapshots, delivery payloads, booking references or booking URLs as fields.
Conversation messages include their SMS text, which the operator needs; the
list shows only the last four phone digits.

## Human review resolution

An open review is `ReplyProcessing.status = ESCALATED` with `reviewResolvedAt IS NULL`
(`OPEN_REVIEW` in `modules/reviews/resolution.ts`). Reply routing
(`AWAITING_HUMAN_REVIEW`), Step 2 and archival wait only for open reviews.
Resolution writes `reviewResolvedAt`, `reviewResolution`, `reviewResolvedBy`
(operator id) and an optional `reviewNote` (≤ 500 chars); the routed outcome and
the record itself are never changed or deleted.

Blocking is lead-level, so a resolution closes every open review of the same lead
(only the one record for an unknown sender).

| Resolution            | Effect                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESUME_AUTOMATION`   | Clears human takeover; eligible automation continues.                                                                                        |
| `KEEP_HUMAN_TAKEOVER` | Starts or keeps human takeover (`automationPausedAt` stays set).                                                                             |
| `ARCHIVE`             | The review's membership → `DORMANT_ARCHIVED` through `transitionCampaignLead`, open booking offer withdrawn. `409` for `BOOKED`/`OPTED_OUT`. |
| `MARK_HANDLED`        | Closes the review; automation state unchanged.                                                                                               |

Repeating the same resolution returns `changed: false` and writes nothing. A
different resolution on a resolved review is `409`. Resolution never bypasses
suppression, terminal states, booking truth or campaign status: every send path
still re-checks them.

## Operator audit

`OperatorAuditEvent` (append-only trigger) records actor id and role, action,
target type/id, request id and minimal metadata (identifiers, counts, enum
values; never credentials, contact data or note text). Written in the same
transaction as the action and only when the action changed something:
`CAMPAIGN_START|PAUSE|RESUME|COMPLETE`, `HUMAN_TAKEOVER`, `RESUME_AUTOMATION`,
`REVIEW_RESOLVED`, `INTEGRATION_REQUEUE`. Rejected (`409`) or repeated requests
leave no audit row.

## Human takeover

`Lead.automationPausedAt` (null = automation active), written only by
`setHumanTakeover` (`modules/leads/takeover.ts`). Lead-wide and durable.

While set:

| Path                                                   | Behavior                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Step 1 (`sendStep1Message`)                            | `SKIPPED_HUMAN_TAKEOVER`; membership stays `QUEUED`; excluded from candidates      |
| Step 2 (`sendStep2Message`)                            | `SKIPPED_HUMAN_TAKEOVER`; excluded from candidates                                 |
| Reply processing                                       | Classified, then `ESCALATED` with `HUMAN_TAKEOVER`; no reply, no membership change |
| Conversational reply / question / booking link send    | Persisted `PENDING` message is `CANCELLED` (`HUMAN_TAKEOVER`), never sent later    |
| Qualification                                          | Not evaluated (`NOT_ELIGIBLE`); excluded from candidates                           |
| Final archival                                         | Not archived until automation resumes                                              |
| Exact opt-out (`STOP` …) and classified `HARD_OPT_OUT` | Still applied: suppression + `OPTED_OUT`                                           |
| Suppression checks before sends                        | Run first; a suppressed lead is cancelled/opted out regardless of takeover         |
| Verified booking events, integration deliveries        | Unchanged: database truth and outbox keep working                                  |

Every send path reads the flag under `FOR SHARE` on the lead row right before
claiming the send, so a takeover waits for an in-progress claim and no new
automated claim starts after it commits. Resuming automation resolves the
lead's open reviews in the same transaction, so no stale escalation keeps
blocking eligible automation.

## Web

Sign-in: the operator pastes their token; it is verified with `GET /auth/me` and
kept in `sessionStorage` (cleared on sign-out, tab close or any `401`). Hash routes:
`#/overview`, `#/campaigns/:id`, `#/conversations[/:leadId][?campaign=]`,
`#/reviews`. Data freshness: `useResource` polling (20–60 s, paused while the tab is
hidden), manual refresh, and reload after every control action. A failed refresh
keeps the last loaded data visible with an error notice; `503` shows a
service-unavailable message. Controls disable while a request is in flight;
completing a campaign, resuming automation and requeueing deliveries ask for
confirmation.
