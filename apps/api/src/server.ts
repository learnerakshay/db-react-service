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
import type { JobQueue } from './jobs/queue.js';
import { ConfigurationError } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
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

let queue: JobQueue | undefined;
if (db !== undefined && config.database.url !== undefined && config.jobs.workersEnabled) {
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
        queues: campaignJobQueues(config.jobs),
      },
      logger,
    ),
  };
  queue = deps.queue;
  try {
    await queue.start();
    await registerCampaignWorkers(deps);
    await scheduleCampaignScheduler(deps);
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
  api: db === undefined ? undefined : apiRouter({ db, config, logger }),
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
