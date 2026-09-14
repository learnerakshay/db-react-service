/**
 * Messaging (SMS) provider boundary. Finalized in Phase 2 / Prompt 1.
 *
 * Application code depends only on these types. Vendor SDKs, payload formats,
 * status vocabularies and error codes stay inside adapter files.
 */

export interface SendMessageInput {
  /** E.164 recipient. */
  to: string;
  /** E.164 sender owned by this service. */
  from: string;
  body: string;
  /** Where the provider should post delivery updates; null disables them. */
  statusCallbackUrl: string | null;
}

export type SendMessageResult =
  /** The provider accepted the message. Not proof of delivery. */
  | { outcome: 'ACCEPTED'; providerMessageId: string; providerStatus: string }
  /**
   * The provider definitely did not accept the message. `retryable` means the
   * same send may be attempted again later without risk of duplication.
   */
  | { outcome: 'REJECTED'; retryable: boolean; recipientOptedOut: boolean; errorCode: string }
  /**
   * The provider may or may not have accepted the message (timeout, 5xx,
   * connection lost mid-request). Never resent automatically.
   */
  | { outcome: 'UNCERTAIN'; errorCode: string };

/** A webhook request exactly as received, for signature verification. */
export interface WebhookRequest {
  /** Public URL the provider called, including any query string. */
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawBody: string;
}

export type DeliveryStatus = 'ACCEPTED' | 'SENT' | 'DELIVERED' | 'FAILED';

export interface InboundMessageEvent {
  kind: 'INBOUND_MESSAGE';
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
}

export interface DeliveryStatusEvent {
  kind: 'DELIVERY_STATUS';
  providerMessageId: string;
  /** Null for provider statuses this service does not track. */
  status: DeliveryStatus | null;
  /** Provider's own status token, kept for audit. */
  providerStatus: string;
  errorCode: string | null;
}

export type NormalizedProviderEvent = InboundMessageEvent | DeliveryStatusEvent;

export interface WebhookAck {
  status: number;
  contentType: string | null;
  body: string;
}

export interface MessagingProvider {
  readonly name: string;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  /** Authenticity check. Must pass before a webhook payload is parsed or trusted. */
  verifyWebhook(request: WebhookRequest): boolean;
  /** Throws ValidationError when the payload is not a valid inbound message. */
  parseInboundWebhook(request: WebhookRequest): InboundMessageEvent;
  /** Throws ValidationError when the payload is not a valid status callback. */
  parseStatusWebhook(request: WebhookRequest): DeliveryStatusEvent;
  /** Response the provider expects after a webhook was handled. */
  webhookAck(kind: NormalizedProviderEvent['kind']): WebhookAck;
}
