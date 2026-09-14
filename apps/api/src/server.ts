import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig, type AppConfig } from './config/index.js';
import { createDatabase, databaseHealthCheck } from './db/client.js';
import { createPgBossQueue } from './jobs/boss.js';
import {
  campaignJobQueues,
  registerCampaignWorkers,
  scheduleCampaignScheduler,
} from './jobs/campaign-scheduler.js';
import {
  outboundJobQueues,
  registerOutboundWorkers,
  scheduleOutboundDispatch,
} from './jobs/outbound-dispatch.js';
import type { JobQueue } from './jobs/queue.js';
import {
  enqueueInboundProcessing,
  registerReplyWorkers,
  replyJobQueues,
  scheduleReplyProcessing,
} from './jobs/reply-processing.js';
import { ConfigurationError } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { createConfiguredAi } from './providers/ai/registry.js';
import { createConfiguredMessaging, statusCallbackUrl } from './providers/messaging/registry.js';
import { apiRouter } from './routes/api.js';

// Repo-root .env (same relative depth from src/ and dist/). Real environment
// variables take precedence over the file.
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

let config: AppConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigurationError) {
    process.stderr.write(`[startup] ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger(config.logLevel);
const db = config.database.url === undefined ? undefined : createDatabase(config.database.url);
if (db === undefined) {
  logger.warn('DATABASE_URL is not set; database-backed features are unavailable');
}

const messaging = createConfiguredMessaging(config);
if (messaging === undefined) {
  logger.warn('SMS_PROVIDER is not set; outbound messaging and messaging webhooks are disabled');
}
const ai = createConfiguredAi(config);
if (messaging !== undefined && ai === undefined) {
  logger.warn(
    'OPENAI_API_KEY is not set; inbound replies are stored but not classified or answered',
  );
}

let queue: JobQueue | undefined;
let onInboundMessage: ((messageId: string) => Promise<void>) | undefined;
if (db !== undefined && config.database.url !== undefined && config.jobs.workersEnabled) {
  const replyProcessingEnabled = messaging !== undefined && ai !== undefined;
  const deps = {
    db,
    logger,
    config,
    queue: createPgBossQueue(
      {
        connectionString: config.database.url,
        schema: config.jobs.schema,
        pollingIntervalSeconds: config.jobs.pollingIntervalSeconds,
        stopTimeoutMs: config.jobs.stopTimeoutMs,
        schedule: true,
        queues: [
          ...campaignJobQueues(config.jobs),
          ...(messaging === undefined ? [] : outboundJobQueues(config.messaging)),
          ...(replyProcessingEnabled ? replyJobQueues(config.replies) : []),
        ],
      },
      logger,
    ),
  };
  queue = deps.queue;
  try {
    await queue.start();
    await registerCampaignWorkers(deps);
    await scheduleCampaignScheduler(deps);
    if (messaging !== undefined) {
      const outbound = {
        db,
        logger,
        provider: messaging.provider,
        fromNumber: messaging.fromNumber,
        statusCallbackUrl: statusCallbackUrl(config, messaging.provider.name),
        sendingStaleAfterMs: config.messaging.sendingStaleAfterMs,
        transactionTimeoutMs: config.messaging.transactionTimeoutMs,
      };
      const outboundDeps = { queue: deps.queue, logger, messaging: config.messaging, outbound };
      await registerOutboundWorkers(outboundDeps);
      await scheduleOutboundDispatch(outboundDeps);

      if (ai !== undefined) {
        const replyJobs = {
          queue: deps.queue,
          logger,
          replyDeps: {
            db,
            ai,
            outbound,
            logger,
            confidenceThreshold: config.classifier.confidenceThreshold,
            replies: config.replies,
          },
        };
        await registerReplyWorkers(replyJobs);
        await scheduleReplyProcessing(replyJobs);
        const jobQueue = deps.queue;
        onInboundMessage = (messageId) => enqueueInboundProcessing(jobQueue, messageId);
      }
    }
  } catch (err) {
    logger.fatal({ err, operation: 'jobs.start' }, 'background jobs failed to start');
    await queue.stop().catch(() => undefined);
    await db.$disconnect();
    process.exit(1);
  }
} else if (db !== undefined) {
  logger.warn('JOB_WORKERS_ENABLED=false; scheduler and workers are not running in this process');
}

const app = createApp({
  config,
  logger,
  checkDatabase: databaseHealthCheck(db, logger),
  api:
    db === undefined
      ? undefined
      : apiRouter({
          db,
          config,
          logger,
          ...(messaging === undefined
            ? {}
            : { messagingProviders: new Map([[messaging.provider.name, messaging.provider]]) }),
          ...(onInboundMessage === undefined ? {} : { onInboundMessage }),
        }),
});

const server = app.listen(config.http.port, () => {
  logger.info({ port: config.http.port, nodeEnv: config.nodeEnv }, 'api listening');
});

server.on('error', (err) => {
  logger.fatal({ err }, 'http server error');
  void shutdown('serverError', 1);
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error({ timeoutMs: config.http.shutdownTimeoutMs }, 'graceful shutdown timed out');
    process.exit(1);
  }, config.http.shutdownTimeoutMs);
  forceExit.unref();

  let code = exitCode;
  try {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    // Stop taking jobs and let active ones finish before closing the database.
    await queue?.stop();
    await db?.$disconnect();
    logger.info('shutdown complete');
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    code = 1;
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});
