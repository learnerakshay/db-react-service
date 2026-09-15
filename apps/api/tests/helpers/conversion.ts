import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import type { IntentClassification } from '../../src/generated/prisma/enums.js';
import type {
  bookingConfigSchema,
  qualificationConfigSchema,
} from '../../src/modules/conversion/config.js';
import {
  processQualification,
  type QualificationDependencies,
} from '../../src/modules/conversion/qualification.js';
import { processInboundMessage } from '../../src/modules/replies/processor.js';
import type { BookingEvent, CalendarProvider } from '../../src/providers/calendar/index.js';
import type { WebhookAck, WebhookRequest } from '../../src/providers/messaging/index.js';
import { FakeAiProvider, intent, type AiStep } from './ai.js';
import { silentLogger } from './db.js';
import { FakeMessagingProvider, outboundDeps } from './messaging.js';
import { contactedLead, receive, replyDeps } from './replies.js';

const TEST_CONFIG = loadConfig({ NODE_ENV: 'test' });

export const QUALIFICATION = {
  fields: [
    {
      key: 'serviceNeeded',
      type: 'string',
      description: 'The service the lead wants',
      question: 'Which service are you interested in?',
      requirements: [{ kind: 'present' }],
    },
    {
      key: 'budget',
      type: 'number',
      description: 'Budget in US dollars',
      question: 'What budget are you working with?',
      requirements: [{ kind: 'min', value: 500 }],
    },
  ],
} satisfies z.input<typeof qualificationConfigSchema>;

export const BOOKING = {
  provider: 'fakecal',
  url: 'https://book.example.test/acme',
  referenceParam: 'ref',
  message: 'You qualify! Pick a time here: {{bookingUrl}}',
} satisfies z.input<typeof bookingConfigSchema>;

export function conversionDeps(
  db: Database,
  ai: FakeAiProvider,
  messaging: FakeMessagingProvider,
): QualificationDependencies {
  return {
    db,
    ai,
    outbound: outboundDeps(db, messaging),
    logger: silentLogger,
    conversion: TEST_CONFIG.conversion,
    replies: TEST_CONFIG.replies,
  };
}

/** Receive an inbound SMS and run the real Phase 2 reply processing on it. */
export async function replyFromLead(
  db: Database,
  ai: FakeAiProvider,
  messaging: FakeMessagingProvider,
  phone: string,
  body: string,
  classification: IntentClassification = 'POSITIVE_INTEREST',
  confidence = 0.95,
): Promise<string> {
  ai.script('intent_analysis', intent(classification, confidence));
  const messageId = await receive(db, phone, body);
  await processInboundMessage(replyDeps(db, ai, messaging), messageId);
  return messageId;
}

export interface EngagedOptions {
  qualification?: unknown;
  /** null: campaign without booking config. */
  booking?: unknown;
  firstReply?: string;
}

/** A lead who received Step 1 and replied positively (membership ENGAGED). */
export async function engagedMember(
  db: Database,
  ai: FakeAiProvider,
  messaging: FakeMessagingProvider,
  options: EngagedOptions = {},
) {
  const context = await contactedLead(db, messaging);
  const current = await db.campaign.findUniqueOrThrow({ where: { id: context.campaign.id } });
  await db.campaign.update({
    where: { id: current.id },
    data: {
      config: {
        ...(current.config as Record<string, unknown>),
        qualification: options.qualification ?? QUALIFICATION,
        ...(options.booking === null ? {} : { booking: options.booking ?? BOOKING }),
      } as never,
    },
  });
  const inbound = await replyFromLead(
    db,
    ai,
    messaging,
    context.lead.phone,
    options.firstReply ?? 'Yes, still interested',
  );
  return { ...context, inbound };
}

type Extracted = Record<string, { value: string | number | boolean; evidence: string }>;

/**
 * Scripted extraction output shaped like a well-behaved model: one entry per
 * requested field, null for fields not in `values`.
 */
export function extracted(values: Extracted): AiStep {
  return {
    run: (request) => {
      const { fields } = JSON.parse(request.input) as { fields: { key: string }[] };
      return Object.fromEntries(
        fields.map((field) => [field.key, values[field.key] ?? { value: null, evidence: null }]),
      );
    },
  };
}

export const CALENDAR_SIGNATURE = 'fake-calendar-signature';

/** Stand-in calendar adapter: header check for authenticity, JSON event body. */
export class FakeCalendarProvider implements CalendarProvider {
  readonly name: string;

  constructor(name = BOOKING.provider) {
    this.name = name;
  }

  verifyWebhook(request: WebhookRequest): boolean {
    return request.headers['x-fake-signature'] === CALENDAR_SIGNATURE;
  }

  parseBookingWebhook(request: WebhookRequest): BookingEvent | null {
    const raw = JSON.parse(request.rawBody) as Record<string, unknown>;
    if (raw.kind === 'OTHER') return null;
    return {
      ...(raw as unknown as BookingEvent),
      startAt: typeof raw.startAt === 'string' ? new Date(raw.startAt) : null,
      endAt: typeof raw.endAt === 'string' ? new Date(raw.endAt) : null,
    };
  }

  webhookAck(): WebhookAck {
    return { status: 204, contentType: null, body: '' };
  }
}

/** A QUALIFIED member (budget 900, gutter cleaning) with an OFFERED, sent booking link. */
export async function qualifiedMember(db: Database) {
  const messaging = new FakeMessagingProvider();
  const ai = new FakeAiProvider();
  const context = await engagedMember(db, ai, messaging);
  const inbound = await replyFromLead(
    db,
    ai,
    messaging,
    context.lead.phone,
    'gutter cleaning, $900',
  );
  ai.script(
    'qualification_extraction',
    extracted({
      serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' },
      budget: { value: 900, evidence: '$900' },
    }),
  );
  await processQualification(conversionDeps(db, ai, messaging), inbound);
  const opportunity = await db.bookingOpportunity.findFirstOrThrow({
    where: { campaignLeadId: context.member.id },
  });
  return { ...context, messaging, ai, opportunity };
}

export const APPOINTMENT_START = new Date('2026-07-20T15:00:00Z');

export function bookingEvent(
  overrides: Partial<BookingEvent> & Pick<BookingEvent, 'kind'>,
): BookingEvent {
  return {
    eventId: randomUUID(),
    externalBookingId: 'booking-1',
    previousExternalBookingId: null,
    bookingReference: null,
    startAt: APPOINTMENT_START,
    endAt: new Date(APPOINTMENT_START.getTime() + 30 * 60_000),
    timezone: 'America/New_York',
    inviteePhone: null,
    inviteeEmail: null,
    ...overrides,
  };
}
