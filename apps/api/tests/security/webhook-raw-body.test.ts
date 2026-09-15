import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import type { BookingEvent, CalendarProvider } from '../../src/providers/calendar/index.js';
import type { WebhookAck, WebhookRequest } from '../../src/providers/messaging/index.js';
import { apiRouter } from '../../src/routes/api.js';
import { authConfig } from '../helpers/auth.js';
import { bookingEvent } from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';

const SECRET = 'calendar-signing-secret';

/** A provider that signs the exact raw JSON body, like most calendar vendors. */
class RawJsonSignedCalendar implements CalendarProvider {
  readonly name = 'signedcal';

  verifyWebhook(request: WebhookRequest): boolean {
    const signature = request.headers['x-signature'];
    const expected = createHmac('sha256', SECRET).update(request.rawBody).digest('hex');
    return (
      typeof signature === 'string' &&
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    );
  }

  parseBookingWebhook(request: WebhookRequest): BookingEvent {
    const raw = JSON.parse(request.rawBody) as { eventId: string; bookingId: string };
    return bookingEvent({
      kind: 'BOOKING_CREATED',
      eventId: raw.eventId,
      externalBookingId: raw.bookingId,
      bookingReference: 'unknown-reference',
    });
  }

  webhookAck(): WebhookAck {
    return { status: 204, contentType: null, body: '' };
  }
}

let db: Database;
let server: Server;
let base: string;

beforeAll(async () => {
  db = connectTestDatabase();
  const config = authConfig();
  const calendar = new RawJsonSignedCalendar();
  const app = createApp({
    config,
    logger: silentLogger,
    checkDatabase: () => Promise.resolve('up'),
    api: apiRouter({
      db,
      config,
      logger: silentLogger,
      calendarProviders: new Map([[calendar.name, calendar]]),
    }),
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/webhooks/calendar/signedcal`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await db.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(db);
});

function post(rawBody: string, signature: string) {
  return fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature },
    body: rawBody,
  });
}

const sign = (rawBody: string) => createHmac('sha256', SECRET).update(rawBody).digest('hex');

describe('raw-body webhook verification', () => {
  it('verifies a JSON webhook signed over its exact raw bytes, without operator auth', async () => {
    // Whitespace and key order matter: re-serialized JSON would not verify.
    const rawBody = '{ "bookingId": "b-1",\n  "eventId": "evt-1" }';
    const res = await post(rawBody, sign(rawBody));
    expect(res.status).toBe(204);
    expect(
      await db.calendarWebhookEvent.findFirstOrThrow({ where: { provider: 'signedcal' } }),
    ).toMatchObject({ eventKey: 'BOOKING_CREATED:evt-1', outcome: 'UNMATCHED' });
  });

  it('rejects a bad signature before any side effect', async () => {
    const rawBody = '{"bookingId":"b-2","eventId":"evt-2"}';
    const res = await post(rawBody, sign(`${rawBody} `));
    expect(res.status).toBe(403);
    expect(await db.calendarWebhookEvent.count()).toBe(0);
  });

  it('enforces the webhook payload limit', async () => {
    const rawBody = JSON.stringify({ bookingId: 'b-3', eventId: 'evt-3', pad: 'x'.repeat(70_000) });
    const res = await post(rawBody, sign(rawBody));
    expect(res.status).toBe(413);
    expect(await db.calendarWebhookEvent.count()).toBe(0);
  });
});
