/**
 * Durable background job boundary.
 *
 * PHASE 0: contract only — no implementation, no workers, no campaign jobs.
 * Phase 1 adds a PostgreSQL-backed adapter (planned: pg-boss) behind this
 * interface. Application code enqueues through JobQueue and never imports the
 * queue library directly. Redis is intentionally not part of the stack.
 *
 * Design rules for handlers (enforced when they exist):
 * - handlers are idempotent: a job may run more than once
 * - retries are bounded (`retryLimit`), never infinite
 * - side effects inside handlers go through provider interfaces and are audited
 */

export interface EnqueueOptions {
  /** Deduplicates enqueues: a second job with the same key is not created. */
  idempotencyKey?: string;
  /** Earliest time the job may run. */
  startAfter?: Date;
  /** Maximum retry attempts after the first failure. */
  retryLimit?: number;
  retryDelaySeconds?: number;
}

export interface Job<TPayload> {
  id: string;
  name: string;
  payload: TPayload;
  /** 1-based attempt number. */
  attempt: number;
}

export type JobHandler<TPayload> = (job: Job<TPayload>) => Promise<void>;

export interface JobQueue {
  start(): Promise<void>;
  /** Stop accepting work and wait for in-flight handlers (graceful shutdown). */
  stop(): Promise<void>;
  /** Returns the job ID, or null when deduplicated by idempotency key. */
  enqueue(name: string, payload: unknown, options?: EnqueueOptions): Promise<string | null>;
  work<TPayload>(name: string, handler: JobHandler<TPayload>): Promise<void>;
}
