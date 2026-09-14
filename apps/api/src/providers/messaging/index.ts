/**
 * Messaging (SMS) provider boundary. PROVISIONAL — finalized in Phase 2.
 * No adapters exist in Phase 0. Sending is a dangerous side effect: callers
 * must be deterministic services that have already passed suppression checks.
 */

export interface OutboundMessage {
  to: string;
  body: string;
  /** Provider-side dedupe so a retried job never double-sends. */
  idempotencyKey: string;
}

export interface SendMessageResult {
  providerMessageId: string;
}

export interface MessagingProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendMessageResult>;
}
