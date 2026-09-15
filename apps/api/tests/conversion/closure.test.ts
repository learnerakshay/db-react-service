import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { applyBookingEvent } from '../../src/modules/conversion/booking-events.js';
import { bookingEvent, qualifiedMember, replyFromLead } from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { receive } from '../helpers/replies.js';

let db: Database;

beforeAll(() => {
  db = connectTestDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(db);
});

const statusOf = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;
const opportunityOf = (id: string) => db.bookingOpportunity.findUniqueOrThrow({ where: { id } });

describe('closing a qualified lead withdraws its open booking offer', () => {
  it('a decline archives the membership and cancels the OFFERED opportunity atomically', async () => {
    const qualified = await qualifiedMember(db);
    expect(await opportunityOf(qualified.opportunity.id)).toMatchObject({ status: 'OFFERED' });

    await replyFromLead(
      db,
      qualified.ai,
      qualified.messaging,
      qualified.lead.phone,
      'Actually no longer interested, thanks',
      'NOT_INTERESTED',
    );

    expect(await statusOf(qualified.member.id)).toBe('DORMANT_ARCHIVED');
    const opportunity = await opportunityOf(qualified.opportunity.id);
    expect(opportunity.status).toBe('CANCELLED');
    expect(opportunity.cancelledAt).not.toBeNull();
    expect(await db.bookingOpportunity.count()).toBe(1);

    // The withdrawn link can no longer produce a booking.
    const late = await applyBookingEvent(
      db,
      'fakecal',
      bookingEvent({
        kind: 'BOOKING_CREATED',
        bookingReference: qualified.opportunity.bookingReference,
      }),
      { transactionTimeoutMs: 30_000 },
    );
    expect(late.outcome).toBe('INVALID_STATE');
    expect(await statusOf(qualified.member.id)).toBe('DORMANT_ARCHIVED');
  });

  it('a hard opt-out cancels the OFFERED opportunity too', async () => {
    const qualified = await qualifiedMember(db);
    await receive(db, qualified.lead.phone, 'STOP');
    expect(await statusOf(qualified.member.id)).toBe('OPTED_OUT');
    expect(await opportunityOf(qualified.opportunity.id)).toMatchObject({ status: 'CANCELLED' });
  });
});
