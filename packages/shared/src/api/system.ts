/** GET /health — process liveness. Never touches dependencies. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
  timestamp: string;
}

export type DependencyStatus = 'up' | 'down' | 'not_configured';

/** GET /ready — whether the process can serve traffic. */
export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  checks: {
    database: DependencyStatus;
    /** Background job queue; `not_configured` when this process runs no workers. */
    jobs: DependencyStatus;
  };
  timestamp: string;
}
