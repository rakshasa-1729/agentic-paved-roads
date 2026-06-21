/**
 * In-memory sliding-window rate limiter keyed by principal or IP.
 * Each window tracks request timestamps; expired entries are pruned
 * on every check. Configurable window and max-request budget.
 */
export interface RateLimitConfig {
  window_ms: number;
  max_requests: number;
}

export class RateLimiter {
  private readonly store = new Map<string, number[]>();

  constructor(private readonly cfg: RateLimitConfig) {}

  /** Returns true if the request is within budget; false to reject. */
  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.cfg.window_ms;
    let hits = this.store.get(key);
    if (!hits) {
      hits = [now];
      this.store.set(key, hits);
      return true;
    }
    // Prune expired entries (keeps the map lean)
    const active = hits.filter((t) => t > cutoff);
    active.push(now);
    this.store.set(key, active);
    return active.length <= this.cfg.max_requests;
  }
}
