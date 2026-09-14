import twilio from 'twilio';
import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import type {
  DeliveryStatus,
  DeliveryStatusEvent,
  InboundMessageEvent,
  MessagingProvider,
  SendMessageResult,
} from './index.js';

/** Twilio adapter. The only module that imports the Twilio SDK. */

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  timeoutMs: number;
}

/** The single SDK call used; replaceable at the network boundary in tests. */
export interface TwilioMessagesClient {
  messages: {
    create(options: {
      to: string;
      from: string;
      body: string;
      statusCallback?: string;
    }): Promise<{ sid: string; status: string }>;
  };
}

export const TWILIO_PROVIDER_NAME = 'twilio';

/** Twilio error 21610: recipient replied STOP to this sender. */
const RECIPIENT_UNSUBSCRIBED = 21610;

/** Failures raised before any request reached Twilio: safe to retry. */
const NOT_SENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const STATUS_MAP: Readonly<Record<string, DeliveryStatus>> = {
  accepted: 'ACCEPTED',
  scheduled: 'ACCEPTED',
  queued: 'ACCEPTED',
  sending: 'ACCEPTED',
  sent: 'SENT',
  delivered: 'DELIVERED',
  undelivered: 'FAILED',
  failed: 'FAILED',
  canceled: 'FAILED',
};

const messageSid = z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/);

const inboundPayload = z.object({
  MessageSid: messageSid,
  From: z.string().trim().min(1).max(32),
  To: z.string().trim().min(1).max(32),
  Body: z.string().max(1600),
});

const statusPayload = z.object({
  MessageSid: messageSid,
  MessageStatus: z.string().trim().min(1).max(32),
  ErrorCode: z.string().trim().max(16).optional(),
});

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function createTwilioProvider(
  config: TwilioConfig,
  client?: TwilioMessagesClient,
): MessagingProvider {
  const messagesClient = client ?? defaultClient(config);

  return {
    name: TWILIO_PROVIDER_NAME,

    async sendMessage(input) {
      try {
        const message = await messagesClient.messages.create({
          to: input.to,
          from: input.from,
          body: input.body,
          ...(input.statusCallbackUrl === null ? {} : { statusCallback: input.statusCallbackUrl }),
        });
        return {
          outcome: 'ACCEPTED',
          providerMessageId: message.sid,
          providerStatus: message.status,
        };
      } catch (err) {
        return classifyTwilioSendError(err);
      }
    },

    verifyWebhook(request) {
      const signature = firstHeader(request.headers['x-twilio-signature']);
      if (signature === undefined || signature === '') return false;
      return twilio.validateRequest(
        config.authToken,
        signature,
        request.url,
        formParams(request.rawBody),
      );
    },

    parseInboundWebhook(request): InboundMessageEvent {
      const parsed = inboundPayload.safeParse(formParams(request.rawBody));
      if (!parsed.success)
        throw ValidationError.fromZod(parsed.error, 'Invalid inbound message webhook');
      return {
        kind: 'INBOUND_MESSAGE',
        providerMessageId: parsed.data.MessageSid,
        from: parsed.data.From,
        to: parsed.data.To,
        body: parsed.data.Body,
      };
    },

    parseStatusWebhook(request): DeliveryStatusEvent {
      const parsed = statusPayload.safeParse(formParams(request.rawBody));
      if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'Invalid status webhook');
      const providerStatus = parsed.data.MessageStatus.toLowerCase();
      return {
        kind: 'DELIVERY_STATUS',
        providerMessageId: parsed.data.MessageSid,
        status: STATUS_MAP[providerStatus] ?? null,
        providerStatus,
        errorCode:
          parsed.data.ErrorCode === undefined || parsed.data.ErrorCode === ''
            ? null
            : parsed.data.ErrorCode,
      };
    },

    webhookAck(kind) {
      return kind === 'INBOUND_MESSAGE'
        ? { status: 200, contentType: 'text/xml', body: EMPTY_TWIML }
        : { status: 204, contentType: null, body: '' };
    },
  };
}

/**
 * Map a failed `messages.create` to a send outcome. Only failures that prove
 * Twilio did not accept the message are REJECTED; anything that might have
 * reached Twilio (timeouts, 5xx, dropped connections, unknown errors) is
 * UNCERTAIN so it is never resent automatically.
 */
export function classifyTwilioSendError(err: unknown): SendMessageResult {
  if (err instanceof twilio.RestException) {
    const errorCode = err.code === undefined ? `HTTP_${err.status}` : String(err.code);
    if (err.status === 429) {
      return { outcome: 'REJECTED', retryable: true, recipientOptedOut: false, errorCode };
    }
    if (err.status >= 400 && err.status < 500 && err.status !== 408) {
      return {
        outcome: 'REJECTED',
        retryable: false,
        recipientOptedOut: err.code === RECIPIENT_UNSUBSCRIBED,
        errorCode,
      };
    }
    return { outcome: 'UNCERTAIN', errorCode };
  }

  const networkCode =
    typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
      ? err.code
      : undefined;
  if (networkCode !== undefined && NOT_SENT_NETWORK_CODES.has(networkCode)) {
    return {
      outcome: 'REJECTED',
      retryable: true,
      recipientOptedOut: false,
      errorCode: networkCode,
    };
  }
  return { outcome: 'UNCERTAIN', errorCode: networkCode ?? 'UNKNOWN_ERROR' };
}

function defaultClient(config: TwilioConfig): TwilioMessagesClient {
  const sdk = twilio(config.accountSid, config.authToken, {
    timeout: config.timeoutMs,
    autoRetry: false,
  });
  return {
    messages: {
      create: async (options) => {
        const message = await sdk.messages.create(options);
        return { sid: message.sid, status: message.status };
      },
    },
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formParams(rawBody: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(rawBody));
}
