import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import twilio from 'twilio';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import { sendStep1Message } from '../../src/modules/messaging/outbound.js';
import type { MessagingProvider } from '../../src/providers/messaging/index.js';
import { createTwilioProvider } from '../../src/providers/messaging/twilio.js';
import { apiRouter } from '../../src/routes/api.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { NY_MORNING } from '../helpers/dispatch.js';
import {
  createMessagingCampaign,
  FakeMessagingProvider,
  OUR_NUMBER,
  outboundDeps,
  providerSid,
  queuedMembers,
} from '../helpers/messaging.js';

const AUTH_TOKEN = 'webhook-test-auth-token';
/** Format-valid placeholder; env validation requires an AC-prefixed SID. */
const TEST_ACCOUNT_SID = `AC${'0'.repeat(32)}`;
const PUBLIC_URL = 'https://hooks.example.test';

let db: Database;
let server: Server;
let localBase: string;
let twilioProvider: MessagingProvider;
const sentSids: string[] = [];

beforeAll(async () => {
  db = connectTestDatabase();
  const config = loadConfig({
    NODE_ENV: 'test',
    API_URL: PUBLIC_URL,
    SMS_PROVIDER: 'twilio',
    SMS_ACCOUNT_ID: TEST_ACCOUNT_SID,
    SMS_AUTH_TOKEN: AUTH_TOKEN,
    SMS_FROM_NUMBER: OUR_NUMBER,
  });
  // Real adapter (real signature verification); only the REST call is stubbed.
  twilioProvider = createTwilioProvider(
    { accountSid: TEST_ACCOUNT_SID, authToken: AUTH_TOKEN, timeoutMs: 1000 },
    {
      messages: {
        create: () => {
          const sid = providerSid();
          sentSids.push(sid);
          return Promise.resolve({ sid, status: 'queued' });
        },
      },
    },
  );
  const app = createApp({
    config,
    logger: silentLogger,
    checkDatabase: () => Promise.resolve('up'),
    api: apiRouter({
      db,
      config,
      logger: silentLogger,
      messagingProviders: new Map([['twilio', twilioProvider]]),
    }),
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  localBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  sentSids.length = 0;
});

interface PostOptions {
  signature?: string;
  /** Body actually sent, when different from the signed params. */
  sentParams?: Record<string, string>;
}

function post(
  kind: 'inbound' | 'status',
  params: Record<string, string>,
  options: PostOptions = {},
) {
  const path = `/api/v1/webhooks/messaging/twilio/${kind}`;
  const signature =
    options.signature ??
    twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_URL}${path}`, params);
  return fetch(`${localBase}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    },
    body: new URLSearchParams(options.sentParams ?? params).toString(),
  });
}

function inbound(from: string, body: string, sid = providerSid()) {
  return { MessageSid: sid, From: from, To: OUR_NUMBER, Body: body };
}

/** A lead that received Step 1 through the Twilio adapter in the given campaign. */
async function contactedLead(campaignName = 'Campaign A', phone?: string) {
  const campaign = await createMessagingCampaign(db, { name: campaignName });
  const [member] = await queuedMembers(db, campaign.id, [phone === undefined ? {} : { phone }]);
  if (member === undefined) throw new Error('no member');
  const sent = await sendStep1Message(outboundDeps(db, twilioProvider), member.id, NY_MORNING);
  expect(sent.outcome).toBe('ACCEPTED');
  const lead = await db.lead.findUniqueOrThrow({ where: { id: member.leadId } });
  return { campaign, member, lead, sid: sentSids.at(-1) ?? '' };
}

describe('inbound webhook', () => {
  it('persists a verified inbound message and associates its campaign', async () => {
    const { lead, member, campaign } = await contactedLead();
    const params = inbound(lead.phone, 'Yes, still interested');

    const res = await post('inbound', params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    expect(await res.text()).toContain('<Response>');

    const message = await db.message.findFirstOrThrow({ where: { direction: 'INBOUND' } });
    expect(message).toMatchObject({
      status: 'RECEIVED',
      purpose: 'INBOUND_REPLY',
      provider: 'twilio',
      providerMessageId: params.MessageSid,
      leadId: lead.id,
      campaignId: campaign.id,
      campaignLeadId: member.id,
      fromNumber: lead.phone,
      toNumber: OUR_NUMBER,
      body: 'Yes, still interested',
      inboundResolution: 'MATCHED',
      safetyAction: null,
    });
    expect(
      await db.providerWebhookEvent.findFirst({ where: { kind: 'INBOUND_MESSAGE' } }),
    ).toMatchObject({
      outcome: 'PROCESSED',
      messageId: message.id,
    });
  });

  it('rejects missing, invalid or mismatched signatures without persisting anything', async () => {
    const params = inbound('+14155552671', 'STOP');
    expect((await post('inbound', params, { signature: '' })).status).toBe(403);
    expect((await post('inbound', params, { signature: 'bogus' })).status).toBe(403);
    expect(
      (await post('inbound', params, { sentParams: { ...params, From: '+14155550000' } })).status,
    ).toBe(403);
    expect(await db.message.count()).toBe(0);
    expect(await db.providerWebhookEvent.count()).toBe(0);
    expect(await db.suppressionEntry.count()).toBe(0);
  });

  it('rejects a correctly signed but malformed payload', async () => {
    const res = await post('inbound', {
      MessageSid: 'not-a-sid',
      From: '+14155552671',
      To: OUR_NUMBER,
      Body: 'hi',
    });
    expect(res.status).toBe(400);
    expect(await db.message.count()).toBe(0);
  });

  it('rejects oversized bodies', async () => {
    const res = await post('inbound', inbound('+14155552671', 'x'.repeat(70_000)));
    expect(res.status).toBe(413);
  });

  it('turns duplicate deliveries of the same webhook into a single message', async () => {
    const { lead } = await contactedLead();
    const params = inbound(lead.phone, 'Who is this?');
    const responses = await Promise.all([post('inbound', params), post('inbound', params)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await post('inbound', params)).status).toBe(200);
    expect(await db.message.count({ where: { direction: 'INBOUND' } })).toBe(1);
    expect(await db.providerWebhookEvent.count()).toBe(1);
  });

  it('stores messages from unknown senders without guessing a lead', async () => {
    expect((await post('inbound', inbound('+14155550199', 'hello?'))).status).toBe(200);
    expect(await db.message.findFirstOrThrow()).toMatchObject({
      leadId: null,
      campaignId: null,
      inboundResolution: 'UNKNOWN_SENDER',
    });
  });

  it('records known leads without campaign context, and ambiguous context, without guessing', async () => {
    const campaign = await createMessagingCampaign(db);
    const [staged] = await queuedMembers(db, campaign.id, [{}]);
    const quietLead = await db.lead.findUniqueOrThrow({ where: { id: staged?.leadId ?? '' } });
    await post('inbound', inbound(quietLead.phone, 'Hi'));
    expect(await db.message.findFirstOrThrow({ where: { direction: 'INBOUND' } })).toMatchObject({
      leadId: quietLead.id,
      inboundResolution: 'NO_CAMPAIGN',
      campaignLeadId: null,
    });

    const first = await contactedLead('Campaign A', '+16505551111');
    await contactedLead('Campaign B', '+16505551111');
    await post('inbound', inbound(first.lead.phone, 'Which offer was this?'));
    expect(
      await db.message.findFirstOrThrow({ where: { direction: 'INBOUND', leadId: first.lead.id } }),
    ).toMatchObject({
      inboundResolution: 'AMBIGUOUS_CAMPAIGN',
      campaignId: null,
      campaignLeadId: null,
    });
  });
});

describe('hard opt-out', () => {
  it('creates one durable global suppression and opts out every membership', async () => {
    const { lead, member } = await contactedLead('Campaign A', '+16505552222');
    const other = await createMessagingCampaign(db, { name: 'Campaign B' });
    const [otherMember] = await queuedMembers(db, other.id, [{ phone: lead.phone }]);

    const stop = inbound(lead.phone, 'STOP');
    expect((await post('inbound', stop)).status).toBe(200);
    expect((await post('inbound', stop)).status).toBe(200);
    expect((await post('inbound', inbound(lead.phone, ' stop. '))).status).toBe(200);

    expect(await db.suppressionEntry.findMany({ where: { phone: lead.phone } })).toMatchObject([
      { reason: 'OPT_OUT', source: 'INBOUND_MESSAGE' },
    ]);
    const statuses = await db.campaignLead.findMany({
      where: { leadId: lead.id },
      select: { id: true, status: true },
    });
    expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({
      [member.id]: 'OPTED_OUT',
      [otherMember?.id ?? '']: 'OPTED_OUT',
    });
    expect(
      await db.message.count({ where: { direction: 'INBOUND', safetyAction: 'HARD_OPT_OUT' } }),
    ).toBe(2);

    // Nothing can be sent to this lead again.
    const provider = new FakeMessagingProvider();
    const attempt = await sendStep1Message(
      outboundDeps(db, provider),
      otherMember?.id ?? '',
      NY_MORNING,
    );
    expect(attempt.outcome).toBe('SKIPPED_NOT_QUEUED');
    expect(provider.calls).toHaveLength(0);
  });

  it('suppresses an unknown sender who texts STOP', async () => {
    await post('inbound', inbound('+14155550123', 'Unsubscribe'));
    expect(await db.suppressionEntry.count({ where: { phone: '+14155550123' } })).toBe(1);
  });

  it('does not hard-suppress ambiguous replies', async () => {
    const { lead, member } = await contactedLead();
    for (const body of [
      'not now',
      'maybe later',
      'who is this?',
      "don't think so",
      'stop texting me',
    ]) {
      expect((await post('inbound', inbound(lead.phone, body))).status).toBe(200);
    }
    expect(await db.suppressionEntry.count()).toBe(0);
    expect(await db.message.count({ where: { safetyAction: { not: null } } })).toBe(0);
    expect((await db.campaignLead.findUniqueOrThrow({ where: { id: member.id } })).status).toBe(
      'STEP_1_SENT',
    );
  });
});

describe('delivery status webhook', () => {
  const status = (sid: string, MessageStatus: string, ErrorCode?: string) =>
    post('status', {
      MessageSid: sid,
      MessageStatus,
      ...(ErrorCode === undefined ? {} : { ErrorCode }),
    });

  it('moves delivery forward and ignores duplicates and stale events', async () => {
    const { sid, member } = await contactedLead();

    expect((await status(sid, 'sent')).status).toBe(204);
    expect((await db.message.findFirstOrThrow({ where: { providerMessageId: sid } })).status).toBe(
      'SENT',
    );

    expect((await status(sid, 'delivered')).status).toBe(204);
    expect((await status(sid, 'delivered')).status).toBe(204);
    expect((await status(sid, 'sent')).status).toBe(204);
    expect((await status(sid, 'undelivered', '30003')).status).toBe(204);

    const message = await db.message.findFirstOrThrow({ where: { providerMessageId: sid } });
    expect(message).toMatchObject({ status: 'DELIVERED', errorCode: null });
    expect(message.sentAt).not.toBeNull();
    expect(message.deliveredAt).not.toBeNull();

    const events = await db.providerWebhookEvent.findMany({
      where: { kind: 'DELIVERY_STATUS' },
      orderBy: { receivedAt: 'asc' },
      select: { providerStatus: true, outcome: true },
    });
    expect(events).toEqual([
      { providerStatus: 'sent', outcome: 'PROCESSED' },
      { providerStatus: 'delivered', outcome: 'PROCESSED' },
      { providerStatus: 'undelivered', outcome: 'STALE' },
    ]);
    expect((await db.campaignLead.findUniqueOrThrow({ where: { id: member.id } })).status).toBe(
      'STEP_1_SENT',
    );
  });

  it('records delivery failures on the message without touching the membership', async () => {
    const { sid, member } = await contactedLead();
    await status(sid, 'undelivered', '30003');
    expect(await db.message.findFirstOrThrow({ where: { providerMessageId: sid } })).toMatchObject({
      status: 'FAILED',
      errorCode: '30003',
    });
    expect((await db.campaignLead.findUniqueOrThrow({ where: { id: member.id } })).status).toBe(
      'STEP_1_SENT',
    );
  });

  it('keeps unknown message ids auditable and rejects bad signatures', async () => {
    const sid = providerSid();
    expect((await status(sid, 'delivered')).status).toBe(204);
    expect(await db.providerWebhookEvent.findFirstOrThrow()).toMatchObject({
      providerMessageId: sid,
      outcome: 'UNKNOWN_MESSAGE',
      messageId: null,
    });
    const forged = await post(
      'status',
      { MessageSid: sid, MessageStatus: 'failed' },
      { signature: 'bogus' },
    );
    expect(forged.status).toBe(403);
  });
});

describe('message audit history', () => {
  it('keeps outbound and inbound messages for a lead in order', async () => {
    const { lead } = await contactedLead();
    await post('inbound', inbound(lead.phone, 'Maybe next week'));
    await post('inbound', inbound(lead.phone, 'STOP'));

    const history = await db.message.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'asc' },
      select: { direction: true, purpose: true, status: true, body: true, safetyAction: true },
    });
    expect(history).toEqual([
      {
        direction: 'OUTBOUND',
        purpose: 'CAMPAIGN_STEP_1',
        status: 'ACCEPTED',
        body: 'Hey there, are you still looking to get your gutters cleaned?',
        safetyAction: null,
      },
      {
        direction: 'INBOUND',
        purpose: 'INBOUND_REPLY',
        status: 'RECEIVED',
        body: 'Maybe next week',
        safetyAction: null,
      },
      {
        direction: 'INBOUND',
        purpose: 'INBOUND_REPLY',
        status: 'RECEIVED',
        body: 'STOP',
        safetyAction: 'HARD_OPT_OUT',
      },
    ]);
  });
});
