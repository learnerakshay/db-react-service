# Mission Control (Phase 4 / Prompt 1)

Operator console in `apps/web` over read models in `apps/api/src/modules/dashboard/`.
Every number is computed server-side from database state. The web app never
derives metrics, never assumes a state change, and shows backend errors as returned.

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
| Human reviews       | `ReplyProcessing.status = ESCALATED` (no resolution workflow exists yet, so all are open).                                                                                             |
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

| Route                                               | Purpose                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /dashboard/overview`                           | KPI metrics above                                                                                                        |
| `GET /dashboard/campaigns?status=`                  | Campaign table (newest first)                                                                                            |
| `GET /campaigns/:id/overview`                       | Campaign summary, metrics, dispatch capacity, recent activity                                                            |
| `POST /campaigns/:id/{start,pause,resume,complete}` | Existing lifecycle actions (`applyCampaignAction`)                                                                       |
| `GET /conversations?filter=&campaignId=`            | One row per lead with messages, newest message first. `filter`: `all`, `attention` (open review or takeover), `takeover` |
| `GET /conversations/:leadId`                        | Latest 200 messages, oldest first, with routed reply outcome, qualification result and booking status                    |
| `GET /reviews?reason=&campaignId=`                  | `ESCALATED` reply processing, newest first. Viewing never resolves                                                       |
| `GET /leads/:id`                                    | Identity, suppression, takeover state, memberships with facts, latest evaluation, bookings, deliveries                   |
| `POST /leads/:id/takeover`                          | Start human takeover                                                                                                     |
| `POST /leads/:id/resume-automation`                 | End human takeover                                                                                                       |
| `GET /integrations/health`                          | Delivery counts per destination, calendar event counts, recent FAILED/RETRY/BLOCKED rows                                 |

Responses never include AI request ids, model names, knowledge item ids, rules
snapshots, delivery payloads, booking references or booking URLs as fields.
Conversation messages include their SMS text, which the operator needs; the
list shows only the last four phone digits.

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
automated claim starts after it commits. Resuming never resolves escalations:
earlier `ESCALATED` records keep blocking automated routing for that lead
(`AWAITING_HUMAN_REVIEW`) until the review resolution workflow (Phase 4 / Prompt 2).

## Web

Hash routes: `#/overview`, `#/campaigns/:id`, `#/conversations[/:leadId][?campaign=]`,
`#/reviews`. Data freshness: `useResource` polling (20–60 s, paused while the tab is
hidden), manual refresh, and reload after every control action. A failed refresh
keeps the last loaded data visible with an error notice.
