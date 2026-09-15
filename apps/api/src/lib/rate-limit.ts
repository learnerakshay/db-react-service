/**
 * Fixed-window counter per key. Abuse control only: domain correctness never
 * depends on it (idempotency keys, row locks and state maps do that).
 *
 * ponytail: per-process memory, so N API instances allow N× the limit and a
 * restart resets counts. A shared store (PostgreSQL table) is the upgrade path.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one hit. Returns false when the key is over its limit. */
  hit(key: string, now: number = Date.now()): boolean {
    const current = this.windows.get(key);
    if (current === undefined || current.resetAt <= now) {
      this.evictExpired(now);
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return this.limit >= 1;
    }
    current.count++;
    return current.count <= this.limit;
  }

  /** True when the key already used its limit in the current window. */
  isBlocked(key: string, now: number = Date.now()): boolean {
    const current = this.windows.get(key);
    return current !== undefined && current.resetAt > now && current.count >= this.limit;
  }

  private evictExpired(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    // Still full of live windows: drop the oldest entry rather than grow unbounded.
    if (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done !== true) this.windows.delete(oldest.value);
    }
  }
}
