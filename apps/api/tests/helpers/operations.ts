import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import { localTimeOfDay } from '../../src/modules/dispatch/send-window.js';
import type { DeliveryDependencies } from '../../src/modules/integrations/deliveries.js';
import { step1SendKey } from '../../src/modules/messaging/outbound.js';
import type { CrmBookingSync, CrmProvider, CrmSyncResult } from '../../src/providers/crm/index.js';
import type {
  HandoffResult,
  PostBookingHandoff,
  PostBookingHandoffProvider,
} from '../../src/providers/handoff/index.js';
import type { IntegrationProviders } from '../../src/providers/integrations.js';
import type {
  NotificationProvider,
  NotificationResult,
  OwnerNotification,
} from '../../src/providers/notifications/index.js';
import { silentLogger } from './db.js';
import type { FakeMessagingProvider } from './messaging.js';
import { contactedLead } from './replies.js';

export const TEST_OPERATIONS = loadConfig({ NODE_ENV: 'test' }).operations;

export const STEP2_TEMPLATE = { body: "No worries at all, I'll close this out for now." };

export interface FollowUpOptions {
  followUpDelayHours?: number;
  archiveDelayDays?: number;
  sendWindow?: { start: string; end: string };
  withStep2?: boolean;
}

/** A lead whose Step 1 was accepted, in a campaign with a Step 2 closeout. */
export async function step1Member(
  db: Database,
  messaging: FakeMessagingProvider,
  options: FollowUpOptions = {},
) {
  const context = await contactedLead(db, messaging);
  const campaign = await db.campaign.findUniqueOrThrow({ where: { id: context.campaign.id } });
  const config = campaign.config as Record<string, unknown>;
  const messages = config.messages as Record<string, unknown>;
  await db.campaign.update({
    where: { id: campaign.id },
    data: {
      config: {
        ...config,
        followUpDelayHours: options.followUpDelayHours ?? 48,
        archiveDelayDays: options.archiveDelayDays ?? 3,
        ...(options.sendWindow === undefined ? {} : { sendWindow: options.sendWindow }),
        messages: {
          ...messages,
          ...(options.withStep2 === false ? {} : { step2: STEP2_TEMPLATE }),
        },
      } as never,
    },
  });
  const step1 = await db.message.findUniqueOrThrow({
    where: { sendKey: step1SendKey(context.member.id) },
  });
  if (step1.acceptedAt === null) throw new Error('step 1 not accepted');
  return { ...context, step1AcceptedAt: step1.acceptedAt };
}

const HOUR_MS = 3_600_000;

/** First whole hour at least `hours` after `from` whose New York local time is in [start, end). */
export function nyHourAfter(from: Date, hours: number, start = '10:00', end = '17:00'): Date {
  let at = new Date(Math.ceil((from.getTime() + hours * HOUR_MS) / HOUR_MS) * HOUR_MS);
  for (let i = 0; i < 48; i++) {
    const local = localTimeOfDay(at, 'America/New_York');
    if (local >= start && local < end) return at;
    at = new Date(at.getTime() + HOUR_MS);
  }
  throw new Error('no matching hour');
}

type Scripted<T> = T | Error;

class Scripts<T> {
  private readonly queue: Scripted<T>[] = [];
  push(...results: Scripted<T>[]): void {
    this.queue.push(...results);
  }
  next(fallback: T): Promise<T> {
    const next = this.queue.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? fallback);
  }
}

export class FakeCrm implements CrmProvider {
  readonly name = 'fake-crm';
  readonly calls: CrmBookingSync[] = [];
  readonly scripts = new Scripts<CrmSyncResult>();
  delayMs = 0;
  async syncBooking(input: CrmBookingSync): Promise<CrmSyncResult> {
    this.calls.push(input);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.scripts.next({
      outcome: 'SYNCED',
      externalContactId: `crm-${input.contact.leadReference}`,
    });
  }
}

export class FakeNotifier implements NotificationProvider {
  readonly name = 'fake-notify';
  readonly calls: OwnerNotification[] = [];
  readonly scripts = new Scripts<NotificationResult>();
  notify(notification: OwnerNotification): Promise<NotificationResult> {
    this.calls.push(notification);
    return this.scripts.next({ outcome: 'DELIVERED', externalReference: 'note-1' });
  }
}

export class FakeHandoff implements PostBookingHandoffProvider {
  readonly name = 'fake-service3';
  readonly calls: PostBookingHandoff[] = [];
  deliver(handoff: PostBookingHandoff): Promise<HandoffResult> {
    this.calls.push(handoff);
    return Promise.resolve({
      outcome: 'ACCEPTED',
      externalReference: `enroll-${handoff.bookingReference}`,
    });
  }
}

export function deliveryDeps(
  db: Database,
  providers: Partial<IntegrationProviders> = {},
): DeliveryDependencies {
  return {
    db,
    logger: silentLogger,
    providers: { crm: undefined, notifications: undefined, handoff: undefined, ...providers },
    operations: TEST_OPERATIONS,
  };
}
