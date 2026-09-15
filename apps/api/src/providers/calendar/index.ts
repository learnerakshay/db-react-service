import type { WebhookAck, WebhookRequest } from '../messaging/index.js';

/**
 * Calendar provider boundary. Finalized in Phase 3 / Prompt 1.
 *
 * Leads book on the provider's own scheduling page, reached through an
 * operator-supplied booking link that carries this service's booking
 * reference. This service never creates appointments; it only consumes
 * verified provider events. Vendor SDKs, payloads and signatures stay inside
 * adapter files. No adapter exists until a calendar vendor is selected.
 */

export type BookingEventKind = 'BOOKING_CREATED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED';

/** One normalized booking event. Validated again by the booking service. */
export interface BookingEvent {
  kind: BookingEventKind;
  /** Provider's identifier for this event delivery; drives idempotency. */
  eventId: string;
  /** Provider's identifier for the booking (appointment). */
  externalBookingId: string;
  /** Booking id this one replaces, when the provider issues a new id on reschedule. */
  previousExternalBookingId: string | null;
  /** Reference this service placed on the booking link, when echoed back. */
  bookingReference: string | null;
  /** Required for created and rescheduled bookings. */
  startAt: Date | null;
  endAt: Date | null;
  /** IANA timezone of the appointment. Required for created and rescheduled bookings. */
  timezone: string | null;
  inviteePhone: string | null;
  inviteeEmail: string | null;
}

export interface CalendarProvider {
  readonly name: string;
  /** Authenticity check. Must pass before a webhook payload is parsed or trusted. */
  verifyWebhook(request: WebhookRequest): boolean;
  /**
   * Normalize a verified webhook. Returns null for provider events this
   * service does not track; throws ValidationError for malformed payloads.
   */
  parseBookingWebhook(request: WebhookRequest): BookingEvent | null;
  webhookAck(): WebhookAck;
}
