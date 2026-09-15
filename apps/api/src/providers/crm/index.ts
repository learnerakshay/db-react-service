/**
 * CRM provider boundary. Finalized in Phase 3 / Prompt 2.
 *
 * The local database stays authoritative; the CRM is a downstream mirror.
 * Vendor SDKs stay inside adapter files. No adapter exists until a CRM vendor
 * is selected.
 */

export interface CrmBookingSync {
  /** Stable per logical action; adapters must use it so retries never duplicate contacts or tags. */
  idempotencyKey: string;
  event: 'BOOKING_CONFIRMED' | 'BOOKING_CANCELLED';
  contact: {
    /** E.164; the contact identity. */
    phone: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    /** Lead id in this service. */
    leadReference: string;
    /** External id from the lead source, when known. */
    sourceExternalId: string | null;
  };
  /** Tags to ensure on the contact (set semantics), e.g. "Reactivated". */
  tags: string[];
  campaign: { id: string; name: string };
  booking: {
    reference: string;
    externalBookingId: string | null;
    startAt: string | null;
    timezone: string | null;
  };
}

export type CrmSyncResult =
  | { outcome: 'SYNCED'; externalContactId: string }
  | { outcome: 'FAILED'; retryable: boolean; errorCode: string };

export interface CrmProvider {
  readonly name: string;
  /** Create or update the contact and apply tags. Must not throw for vendor failures. */
  syncBooking(input: CrmBookingSync): Promise<CrmSyncResult>;
}
