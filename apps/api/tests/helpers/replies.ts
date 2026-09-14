import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import { recordInboundMessage } from '../../src/modules/messaging/inbound.js';
import { sendStep1Message } from '../../src/modules/messaging/outbound.js';
import type { ReplyDependencies } from '../../src/modules/replies/processor.js';
import type { ReplyTemplates } from '../../src/modules/replies/reply-templates.js';
import type { AiProvider } from '../../src/providers/ai/index.js';
import type { MessagingProvider } from '../../src/providers/messaging/index.js';
import { silentLogger } from './db.js';
import { NY_MORNING } from './dispatch.js';
import {
  createMessagingCampaign,
  OUR_NUMBER,
  outboundDeps,
  providerSid,
  queuedMembers,
  STEP1_TEMPLATE,
} from './messaging.js';

export const REPLY_TEMPLATES = {
  positive: 'Great! Someone from our team will text you shortly to get you scheduled.',
  decline: 'No problem at all, thanks for letting us know.',
  clarify: 'Sorry for any confusion! This is Acme Gutters. Are you still interested in a cleaning?',
  handoff: 'Good question! A team member will follow up with the details shortly.',
} satisfies ReplyTemplates;

export const TEST_REPLIES_CONFIG = loadConfig({ NODE_ENV: 'test' }).replies;

export function replyDeps(
  db: Database,
  ai: AiProvider,
  provider: MessagingProvider,
  overrides: Partial<ReplyDependencies> = {},
): ReplyDependencies {
  return {
    db,
    ai,
    outbound: outboundDeps(db, provider),
    logger: silentLogger,
    confidenceThreshold: 0.75,
    replies: TEST_REPLIES_CONFIG,
    ...overrides,
  };
}

export interface ContactedLeadOptions {
  /** Reply templates for the campaign; defaults to REPLY_TEMPLATES. */
  templates?: ReplyTemplates;
  name?: string;
  phone?: string;
}

/** A lead who received Step 1 in a fresh campaign (membership STEP_1_SENT). */
export async function contactedLead(
  db: Database,
  provider: MessagingProvider,
  options: ContactedLeadOptions = {},
) {
  const campaign = await createMessagingCampaign(db, { name: options.name ?? 'Reply campaign' });
  await db.campaign.update({
    where: { id: campaign.id },
    data: {
      config: {
        ...(campaign.config as Record<string, unknown>),
        messages: { step1: STEP1_TEMPLATE, replies: options.templates ?? REPLY_TEMPLATES },
      },
    },
  });
  const [member] = await queuedMembers(db, campaign.id, [
    options.phone === undefined ? {} : { phone: options.phone },
  ]);
  if (member === undefined) throw new Error('no member');
  const sent = await sendStep1Message(outboundDeps(db, provider), member.id, NY_MORNING);
  if (sent.outcome !== 'ACCEPTED') throw new Error(`step 1 not accepted: ${sent.outcome}`);
  const lead = await db.lead.findUniqueOrThrow({ where: { id: member.leadId } });
  return { campaign, member, lead };
}

/** Store an inbound SMS through the real Prompt 1 inbound path. */
export async function receive(db: Database, from: string, body: string): Promise<string> {
  const result = await recordInboundMessage(
    db,
    'fake',
    { kind: 'INBOUND_MESSAGE', providerMessageId: providerSid(), from, to: OUR_NUMBER, body },
    { transactionTimeoutMs: 30_000 },
  );
  if (result.messageId === null) throw new Error('inbound message not stored');
  return result.messageId;
}
