import type { DependencyStatus, HealthResponse, ReadinessResponse } from '@cadentor/shared';
import { Router } from 'express';

export interface SystemRouteDeps {
  serviceName: string;
  checkDatabase: () => Promise<DependencyStatus>;
}

export function systemRouter({ serviceName, checkDatabase }: SystemRouteDeps): Router {
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

  // Readiness: required infrastructure is reachable.
  router.get('/ready', async (_req, res) => {
    const database = await checkDatabase();
    const ready = database === 'up';
    const body: ReadinessResponse = {
      status: ready ? 'ready' : 'not_ready',
      checks: { database },
      timestamp: new Date().toISOString(),
    };
    res.status(ready ? 200 : 503).json(body);
  });

  return router;
}
