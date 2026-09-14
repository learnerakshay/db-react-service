import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { createPgBossQueue } from '../../src/jobs/boss.js';
import type { JobQueue } from '../../src/jobs/queue.js';
import {
  enqueueInboundProcessing,
  enqueueReplyWork,
  registerReplyWorkers,
  REPLY_JOB_NAMES,
  replyJobQueues,
  type ReplyJobDeps,
} from '../../src/jobs/reply-processing.js';
import { FakeAiProvider, intent } from '../helpers/ai.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { FakeMessagingProvider } from '../helpers/messaging.js';
import { contactedLead, receive, replyDeps, TEST_REPLIES_CONFIG } from '../helpers/replies.js';

/** Real pg-boss workers; only the AI and SMS network boundaries are faked. */

let db: Database;
const running: JobQueue[] = [];

async function startWorkers(
  ai: FakeAiProvider,
  messaging: FakeMessagingProvider,
): Promise<ReplyJobDeps> {
  const queue = createPgBossQueue(
    {
      connectionString: inject('databaseUrl'),
      schema: 'pgboss_test',
      pollingIntervalSeconds: 0.5,
      stopTimeoutMs: 5_000,
      schedule: false,
      queues: replyJobQueues(TEST_REPLIES_CONFIG),
    },
    silentLogger,
  );
  await queue.start();
  running.push(queue);
  const deps: ReplyJobDeps = {
    queue,
    logger: silentLogger,
    replyDeps: replyDeps(db, ai, messaging),
  };
  await registerReplyWorkers(deps);
  return deps;
}

async function stopAll() {
  await Promise.all(running.splice(0).map((queue) => queue.stop()));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('condition not met in time');
}

beforeAll(() => {
  db = connectTestDatabase();
});
afterAll(async () => {
  await stopAll();
  await db.$disconnect();
});
beforeEach(async () => {
  await stopAll();
  await resetDatabase(db);
});

describe('reply processing with pg-boss', () => {
  it('classifies and replies once despite duplicate ticks, duplicate jobs and a restart', async () => {
    const ai = new FakeAiProvider().script('intent_analysis', intent('POSITIVE_INTEREST'));
    ai.delayMs = 200;
    const messaging = new FakeMessagingProvider();
    let deps = await startWorkers(ai, messaging);
    const { lead } = await contactedLead(db, messaging);
    const inbound = await receive(db, lead.phone, 'yes, still interested');

    await Promise.all([
      enqueueInboundProcessing(deps.queue, inbound),
      enqueueReplyWork(deps),
      enqueueReplyWork(deps),
      deps.queue.enqueue(
        REPLY_JOB_NAMES.process,
        { messageId: inbound },
        { idempotencyKey: `dup-${inbound}` },
      ),
    ]);
    await waitFor(async () => {
      const reply = await db.message.findFirst({ where: { purpose: 'CONVERSATIONAL_REPLY' } });
      return reply?.status === 'ACCEPTED';
    });

    await stopAll();
    deps = await startWorkers(ai, messaging);
    expect(await enqueueReplyWork(deps)).toEqual({ inbound: 0, pendingReplies: 0 });
    await deps.queue.enqueue(
      REPLY_JOB_NAMES.process,
      { messageId: inbound },
      { idempotencyKey: `again-${inbound}` },
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(ai.calls('intent_analysis')).toHaveLength(1);
    expect(await db.message.count({ where: { purpose: 'CONVERSATIONAL_REPLY' } })).toBe(1);
    expect(messaging.calls).toHaveLength(2);
    expect(
      (await db.replyProcessing.findUniqueOrThrow({ where: { inboundMessageId: inbound } })).status,
    ).toBe('COMPLETED');
  });
});
