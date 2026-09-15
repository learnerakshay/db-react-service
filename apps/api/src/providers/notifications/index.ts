/**
 * Owner notification provider boundary. Finalized in Phase 3 / Prompt 2.
 *
 * The recipient (owner channel) belongs to the adapter's own configuration.
 * No adapter exists until a notification vendor is selected.
 */

export interface OwnerNotification {
  /** Stable per logical notification; adapters pass it on where the vendor supports it. */
  idempotencyKey: string;
  subject: string;
  /** Plain text, no contact details beyond the lead name and references. */
  body: string;
}

export type NotificationResult =
  | { outcome: 'DELIVERED'; externalReference: string | null }
  | { outcome: 'FAILED'; retryable: boolean; errorCode: string };

export interface NotificationProvider {
  readonly name: string;
  /** Must not throw for vendor failures. */
  notify(notification: OwnerNotification): Promise<NotificationResult>;
}
