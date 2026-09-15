import { randomBytes } from 'node:crypto';
import type { DbClient } from '../../db/client.js';
import {
  BookingStatus,
  MessageDirection,
  MessagePurpose,
  MessageStatus,
} from '../../generated/prisma/enums.js';
import { BOOKING_URL_PLACEHOLDER, type BookingConfig } from './config.js';

/** One logical booking-link send per opportunity (UNIQUE Message.sendKey). */
export function bookingLinkSendKey(opportunityId: string): string {
  return `${opportunityId}:${MessagePurpose.BOOKING_LINK}`;
}

/**
 * Withdraw a membership's open (OFFERED) booking offer when its business flow
 * closes: decline, opt-out or operator archive. The row is kept as CANCELLED;
 * CONFIRMED bookings are never touched (only a verified provider event changes them).
 */
export async function cancelOpenBookingOffers(
  tx: DbClient,
  campaignLeadId: string,
  now: Date,
): Promise<number> {
  const { count } = await tx.bookingOpportunity.updateMany({
    where: { campaignLeadId, status: BookingStatus.OFFERED },
    data: { status: BookingStatus.CANCELLED, cancelledAt: now },
  });
  return count;
}

/** Operator URL plus the opportunity's reference, so the provider can echo it back. */
export function buildBookingUrl(config: BookingConfig, bookingReference: string): string {
  const url = new URL(config.url);
  url.searchParams.set(config.referenceParam, bookingReference);
  return url.toString();
}

export function renderBookingMessage(config: BookingConfig, bookingUrl: string): string {
  return config.message.replace(BOOKING_URL_PLACEHOLDER, bookingUrl);
}

export interface BookingOfferInput {
  campaignLeadId: string;
  campaignId: string;
  leadId: string;
  toNumber: string;
  fromNumber: string;
  messagingProvider: string;
  booking: BookingConfig;
}

/**
 * Create the booking opportunity for a QUALIFIED membership and persist its
 * link message (PENDING) in the caller's transaction. The caller holds the
 * membership row lock.
 *
 * Policy: one automatic offer per membership. If any opportunity exists
 * (offered, confirmed, cancelled or expired) nothing new is created; a
 * re-offer after cancellation is a human decision. The partial unique index
 * on active opportunities backs this under any race.
 *
 * Creating the offer never changes membership status: a sent link is not a booking.
 */
export async function offerBooking(
  tx: DbClient,
  input: BookingOfferInput,
): Promise<{ opportunityId: string; messageId: string | null }> {
  const existing = await tx.bookingOpportunity.findFirst({
    where: { campaignLeadId: input.campaignLeadId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (existing !== null) return { opportunityId: existing.id, messageId: null };

  const bookingReference = randomBytes(24).toString('base64url');
  const bookingUrl = buildBookingUrl(input.booking, bookingReference);
  const opportunity = await tx.bookingOpportunity.create({
    data: {
      campaignLeadId: input.campaignLeadId,
      status: BookingStatus.OFFERED,
      calendarProvider: input.booking.provider,
      bookingReference,
      bookingUrl,
    },
  });
  const message = await tx.message.create({
    data: {
      direction: MessageDirection.OUTBOUND,
      purpose: MessagePurpose.BOOKING_LINK,
      status: MessageStatus.PENDING,
      provider: input.messagingProvider,
      leadId: input.leadId,
      campaignId: input.campaignId,
      campaignLeadId: input.campaignLeadId,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      body: renderBookingMessage(input.booking, bookingUrl),
      sendKey: bookingLinkSendKey(opportunity.id),
    },
  });
  await tx.bookingOpportunity.update({
    where: { id: opportunity.id },
    data: { linkMessageId: message.id },
  });
  return { opportunityId: opportunity.id, messageId: message.id };
}
