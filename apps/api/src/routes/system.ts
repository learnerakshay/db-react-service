import type { DependencyStatus, HealthResponse, ReadinessResponse } from '@cadentor/shared';
import { Router } from 'express';

export interface SystemRouteDeps {
  serviceName: string;
  checkDatabase: () => Promise<DependencyStatus>;
  /** Job queue state; absent means this process runs no workers. */
  checkJobs?: () => DependencyStatus;
}

/** Probe routes: never authenticated, never expose configuration or credentials. */
export function systemRouter({ serviceName, checkDatabase, checkJobs }: SystemRouteDeps): Router {
  const router = Router();

  // Liveness: the process is up. Must not depend on external systems.
  router.get('/health', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      service: serviceName,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
    res.json(body);
  });

  // Readiness: infrastructure this configuration requires is available.
  // Optional, unconfigured parts (`not_configured` jobs) never fail readiness.
  router.get('/ready', async (_req, res) => {
    const database = await checkDatabase();
    const jobs = checkJobs?.() ?? 'not_configured';
    const ready = database === 'up' && jobs !== 'down';
    const body: ReadinessResponse = {
      status: ready ? 'ready' : 'not_ready',
      checks: { database, jobs },
      timestamp: new Date().toISOString(),
    };
    res.status(ready ? 200 : 503).json(body);
  });

  return router;
}
