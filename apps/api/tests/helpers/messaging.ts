import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/db/client.js';
import type { CampaignStatus } from '../../src/generated/prisma/enums.js';
import type { OutboundDependencies } from '../../src/modules/messaging/outbound.js';
import type {
  DeliveryStatusEvent,
  InboundMessageEvent,
  MessagingProvider,
  SendMessageInput,
  SendMessageResult,
  WebhookAck,
} from '../../src/providers/messaging/index.js';
import { silentLogger } from './db.js';
import { admit, NY_MORNING, stageMembers, type MemberSpec } from './dispatch.js';

export const OUR_NUMBER = '+15005550006';

export const STEP1_TEMPLATE = {
  body: 'Hey {{firstName}}, are you still looking to {{outcome}}?',
  variables: { outcome: 'get your gutters cleaned' },
  fallbacks: { firstName: 'there' },
};

export function providerSid(): string {
  return `SM${randomUUID().replaceAll('-', '')}`;
}

type ScriptedResult = SendMessageResult | (() => Promise<SendMessageResult>);

/** Stand-in for the provider network boundary. Records every send attempt. */
export class FakeMessagingProvider implements MessagingProvider {
  readonly name: string;
  readonly calls: SendMessageInput[] = [];
  delayMs = 0;
  private readonly scripted: ScriptedResult[] = [];

  constructor(name = 'fake') {
    this.name = name;
  }

  script(...results: ScriptedResult[]): this {
    this.scripted.push(...results);
    return this;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.calls.push(input);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const next = this.scripted.shift();
    if (next === undefined) {
      return { outcome: 'ACCEPTED', providerMessageId: providerSid(), providerStatus: 'queued' };
    }
    return typeof next === 'function' ? next() : next;
  }

  verifyWebhook(): boolean {
    return false;
  }

  parseInboundWebhook(): InboundMessageEvent {
    throw new Error('FakeMessagingProvider does not parse webhooks');
  }

  parseStatusWebhook(): DeliveryStatusEvent {
    throw new Error('FakeMessagingProvider does not parse webhooks');
  }

  webhookAck(): WebhookAck {
    return { status: 204, contentType: null, body: '' };
  }
}

export function outboundDeps(
  db: Database,
  provider: MessagingProvider,
  overrides: Partial<OutboundDependencies> = {},
): OutboundDependencies {
  return {
    db,
    provider,
    logger: silentLogger,
    fromNumber: OUR_NUMBER,
    statusCallbackUrl: null,
    sendingStaleAfterMs: 10 * 60_000,
    transactionTimeoutMs: 30_000,
    ...overrides,
  };
}

export interface MessagingCampaignOptions {
  status?: CampaignStatus;
  timezone?: string | null;
  sendWindow?: { start: string; end: string };
  withTemplate?: boolean;
  name?: string;
}

export async function createMessagingCampaign(
  db: Database,
  options: MessagingCampaignOptions = {},
) {
  return db.campaign.create({
    data: {
      name: options.name ?? 'Messaging test',
      status: options.status ?? 'ACTIVE',
      config: {
        timezone: options.timezone === undefined ? 'America/New_York' : options.timezone,
        sendWindow: options.sendWindow ?? { start: '09:00', end: '18:00' },
        hourlyDispatchLimit: 100,
        followUpDelayHours: 48,
        archiveDelayDays: 14,
        ...(options.withTemplate === false ? {} : { messages: { step1: STEP1_TEMPLATE } }),
      },
    },
  });
}

/** Stage leads and admit them to QUEUED through the real Phase 1 path. */
export async function queuedMembers(
  db: Database,
  campaignId: string,
  specs: readonly MemberSpec[],
) {
  const members = await stageMembers(db, campaignId, specs);
  const result = await admit(db, campaignId, { now: NY_MORNING });
  if (result.admitted !== members.length) {
    throw new Error(`expected ${members.length} admissions, got ${result.admitted}`);
  }
  return members;
}
