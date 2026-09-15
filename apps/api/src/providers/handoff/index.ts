/**
 * Post-booking handoff boundary (Phase 3 / Prompt 2): delivers booking events
 * to the downstream no-show prevention service (Service 3). Service 3 is not
 * implemented here and no endpoint is configured, so no adapter exists;
 * handoff deliveries stay BLOCKED until one is added.
 */

export interface PostBookingHandoff {
  /** Stable per logical event; the consumer deduplicates on it. */
  idempotencyKey: string;
  event: 'BOOKING_CONFIRMED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED';
  /** Enrollment identity: one booking, one enrollment. */
  bookingReference: string;
  lead: { reference: string; phone: string; firstName: string | null; timezone: string | null };
  campaign: { id: string; name: string };
  appointment: { startAt: string | null; endAt: string | null; timezone: string | null };
}

export type HandoffResult =
  | { outcome: 'ACCEPTED'; externalReference: string | null }
  | { outcome: 'FAILED'; retryable: boolean; errorCode: string };

export interface PostBookingHandoffProvider {
  readonly name: string;
  deliver(handoff: PostBookingHandoff): Promise<HandoffResult>;
}
