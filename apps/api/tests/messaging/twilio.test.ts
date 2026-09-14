import twilio from 'twilio';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import type { WebhookRequest } from '../../src/providers/messaging/index.js';
import {
  classifyTwilioSendError,
  createTwilioProvider,
  type TwilioMessagesClient,
} from '../../src/providers/messaging/twilio.js';
import { providerSid } from '../helpers/messaging.js';

const AUTH_TOKEN = 'unit-test-auth-token';
/** Format-valid placeholder; the Twilio SDK rejects SIDs without the AC prefix. */
const TEST_ACCOUNT_SID = `AC${'0'.repeat(32)}`;
const URL = 'https://hooks.example.test/api/v1/webhooks/messaging/twilio/inbound';

function signed(
  params: Record<string, string>,
  overrides: Partial<WebhookRequest> = {},
): WebhookRequest {
  return {
    url: URL,
    headers: { 'x-twilio-signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, URL, params) },
    rawBody: new URLSearchParams(params).toString(),
    ...overrides,
  };
}

function restError(status: number, code?: number) {
  return new twilio.RestException({
    statusCode: status,
    body: JSON.stringify(code === undefined ? {} : { code, message: 'Twilio error' }),
  });
}

const provider = createTwilioProvider({
  accountSid: TEST_ACCOUNT_SID,
  authToken: AUTH_TOKEN,
  timeoutMs: 1000,
});

describe('twilio webhook verification', () => {
  const params = {
    MessageSid: providerSid(),
    From: '+14155552671',
    To: '+15005550006',
    Body: 'Hi',
  };

  it('accepts a correctly signed request', () => {
    expect(provider.verifyWebhook(signed(params))).toBe(true);
  });

  it('rejects missing, wrong, or mismatched signatures', () => {
    expect(provider.verifyWebhook({ ...signed(params), headers: {} })).toBe(false);
    expect(
      provider.verifyWebhook({ ...signed(params), headers: { 'x-twilio-signature': 'bogus' } }),
    ).toBe(false);
    expect(provider.verifyWebhook(signed(params, { url: `${URL}?x=1` }))).toBe(false);
    expect(
      provider.verifyWebhook(
        signed(params, { rawBody: new URLSearchParams({ ...params, Body: 'STOP' }).toString() }),
      ),
    ).toBe(false);

    const otherToken = createTwilioProvider({
      accountSid: TEST_ACCOUNT_SID,
      authToken: 'other',
      timeoutMs: 1000,
    });
    expect(otherToken.verifyWebhook(signed(params))).toBe(false);
  });
});

describe('twilio payload parsing', () => {
  it('normalizes inbound messages', () => {
    const sid = providerSid();
    expect(
      provider.parseInboundWebhook(
        signed({ MessageSid: sid, From: '+14155552671', To: '+15005550006', Body: 'Yes!' }),
      ),
    ).toEqual({
      kind: 'INBOUND_MESSAGE',
      providerMessageId: sid,
      from: '+14155552671',
      to: '+15005550006',
      body: 'Yes!',
    });
  });

  it('rejects malformed payloads', () => {
    expect(() =>
      provider.parseInboundWebhook(signed({ MessageSid: 'nope', From: 'x', To: 'y', Body: '' })),
    ).toThrow(ValidationError);
    expect(() => provider.parseStatusWebhook(signed({ MessageSid: providerSid() }))).toThrow(
      ValidationError,
    );
  });

  it.each([
    ['queued', 'ACCEPTED'],
    ['sending', 'ACCEPTED'],
    ['sent', 'SENT'],
    ['delivered', 'DELIVERED'],
    ['undelivered', 'FAILED'],
    ['failed', 'FAILED'],
    ['read', null],
  ] as const)('maps status %s to %s', (providerStatus, status) => {
    const event = provider.parseStatusWebhook(
      signed({ MessageSid: providerSid(), MessageStatus: providerStatus, ErrorCode: '' }),
    );
    expect(event).toMatchObject({
      kind: 'DELIVERY_STATUS',
      status,
      providerStatus,
      errorCode: null,
    });
  });

  it('acknowledges inbound with empty TwiML and status with 204', () => {
    expect(provider.webhookAck('INBOUND_MESSAGE')).toMatchObject({
      status: 200,
      contentType: 'text/xml',
    });
    expect(provider.webhookAck('DELIVERY_STATUS')).toEqual({
      status: 204,
      contentType: null,
      body: '',
    });
  });
});

describe('twilio send outcome classification', () => {
  it.each([
    [
      restError(400, 21211),
      { outcome: 'REJECTED', retryable: false, recipientOptedOut: false, errorCode: '21211' },
    ],
    [
      restError(400, 21610),
      { outcome: 'REJECTED', retryable: false, recipientOptedOut: true, errorCode: '21610' },
    ],
    [
      restError(429, 20429),
      { outcome: 'REJECTED', retryable: true, recipientOptedOut: false, errorCode: '20429' },
    ],
    [
      restError(401),
      { outcome: 'REJECTED', retryable: false, recipientOptedOut: false, errorCode: 'HTTP_401' },
    ],
    [restError(500, 20500), { outcome: 'UNCERTAIN', errorCode: '20500' }],
    [restError(408), { outcome: 'UNCERTAIN', errorCode: 'HTTP_408' }],
    [
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      { outcome: 'REJECTED', retryable: true, recipientOptedOut: false, errorCode: 'ECONNREFUSED' },
    ],
    [
      Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
      { outcome: 'UNCERTAIN', errorCode: 'ECONNABORTED' },
    ],
    [new Error('socket hang up'), { outcome: 'UNCERTAIN', errorCode: 'UNKNOWN_ERROR' }],
  ])('%s', (error, expected) => {
    expect(classifyTwilioSendError(error)).toEqual(expected);
  });

  it('sends through the client and reports acceptance', async () => {
    const created: unknown[] = [];
    const client: TwilioMessagesClient = {
      messages: {
        create: (options) => {
          created.push(options);
          return Promise.resolve({ sid: 'SM00000000000000000000000000000001', status: 'queued' });
        },
      },
    };
    const withClient = createTwilioProvider(
      { accountSid: TEST_ACCOUNT_SID, authToken: AUTH_TOKEN, timeoutMs: 1000 },
      client,
    );
    const result = await withClient.sendMessage({
      to: '+14155552671',
      from: '+15005550006',
      body: 'Hello',
      statusCallbackUrl: 'https://hooks.example.test/status',
    });
    expect(result).toEqual({
      outcome: 'ACCEPTED',
      providerMessageId: 'SM00000000000000000000000000000001',
      providerStatus: 'queued',
    });
    expect(created).toEqual([
      {
        to: '+14155552671',
        from: '+15005550006',
        body: 'Hello',
        statusCallback: 'https://hooks.example.test/status',
      },
    ]);
  });
});
