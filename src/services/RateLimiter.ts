/**
 * Token-bucket rate limiter.
 *
 * Each (key, action) pair owns an independent bucket so that, for example,
 * a client's `swipe` flood does not starve its own `match-request` budget.
 *
 * Designed for per-WebSocket-connection and per-user enforcement. The store
 * is in-memory; swap for a Redis-backed implementation for horizontal scale.
 *
 * Time is injected via `nowFn` to match the repo's test convention of fake
 * clocks (see e.g. SessionTracker / MatchSignaling tests).
 */

export interface RateLimitRule {
  /** Maximum tokens the bucket can hold. Also the burst size. */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSec: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Remaining tokens after the attempt (floored to 4 dp). */
  remaining: number;
  /** Milliseconds until at least one token is available. 0 if allowed. */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
  lastAccessMs: number; // Track last access for garbage collection
}

export type NowFn = () => number;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly STALE_THRESHOLD_MS = 3600000; // 1 hour
  private lastCleanupMs = 0;
  private readonly CLEANUP_INTERVAL_MS = 300000; // 5 minutes

  constructor(
    private readonly rules: Record<string, RateLimitRule>,
    private readonly nowFn: NowFn = Date.now
  ) {
    for (const [action, rule] of Object.entries(rules)) {
      if (rule.capacity <= 0 || rule.refillPerSec <= 0) {
        throw new Error(`RateLimiter: invalid rule for action "${action}"`);
      }
    }
  }

  /**
   * Attempt to consume a single token for `(key, action)`.
   * Unknown actions are allowed through — callers decide which actions to meter.
   */
  consume(key: string, action: string): RateLimitDecision {
    const rule = this.rules[action];
    if (!rule) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterMs: 0 };
    }

    const bucketKey = `${action}::${key}`;
    const now = this.nowFn();

    // Periodically clean up stale buckets
    this.maybeCleanupStaleBuckets(now);

    const existing = this.buckets.get(bucketKey);

    const bucket: Bucket = existing
      ? { ...this.refill(existing, rule, now), lastAccessMs: now }
      : { tokens: rule.capacity, updatedAtMs: now, lastAccessMs: now };

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(bucketKey, bucket);
      return {
        allowed: true,
        remaining: Number(bucket.tokens.toFixed(4)),
        retryAfterMs: 0
      };
    }

    // Not enough tokens — compute retry-after to the next whole token.
    const deficit = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / rule.refillPerSec) * 1000);
    this.buckets.set(bucketKey, bucket);
    return {
      allowed: false,
      remaining: Number(bucket.tokens.toFixed(4)),
      retryAfterMs
    };
  }

  /** Clear state for a key across all actions (e.g. on disconnect). */
  reset(key: string): void {
    for (const bucketKey of Array.from(this.buckets.keys())) {
      if (bucketKey.endsWith(`::${key}`)) {
        this.buckets.delete(bucketKey);
      }
    }
  }

  /** For tests / observability. */
  peek(key: string, action: string): number | null {
    const rule = this.rules[action];
    if (!rule) return null;
    const bucket = this.buckets.get(`${action}::${key}`);
    if (!bucket) return rule.capacity;
    const refilled = this.refill({ ...bucket }, rule, this.nowFn());
    return Number(refilled.tokens.toFixed(4));
  }

  /** Clean up buckets that haven't been accessed in over an hour */
  private maybeCleanupStaleBuckets(now: number): void {
    if (now - this.lastCleanupMs < this.CLEANUP_INTERVAL_MS) {
      return;
    }

    this.lastCleanupMs = now;
    const cutoff = now - this.STALE_THRESHOLD_MS;

    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.lastAccessMs < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  private refill(bucket: Bucket, rule: RateLimitRule, now: number): Bucket {
    const elapsedMs = Math.max(0, now - bucket.updatedAtMs);
    const refill = (elapsedMs / 1000) * rule.refillPerSec;
    return {
      tokens: Math.min(rule.capacity, bucket.tokens + refill),
      updatedAtMs: now,
      lastAccessMs: bucket.lastAccessMs
    };
  }
}
