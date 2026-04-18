/**
 * SwipeProcessor – swipe event ingestion and behavioural signal extraction.
 *
 * Consumes a stream of swipe events of the shape
 *   `{ userId, targetId, action, dwellTimeMs, scrollVelocity }`
 * and
 *   - updates Glicko-2 ratings of both parties via `EloService.headToHead`
 *   - extracts compatibility bonus signals:
 *       · dwellTimeMs > 3000 → +2 compatibility ("high interest")
 *       · scrollVelocity < 100 px/s → +1 compatibility ("careful browsing")
 *   - applies a cooldown when a user skips more than 5 times in a 10 s window
 *   - reports all of the above back to the caller for downstream persistence
 *     and interest-graph updates.
 */

import { EloService } from './EloService';

export type SwipeAction = 'like' | 'skip' | 'superlike';

/** Input payload for `SwipeProcessor.process`. */
export interface SwipeEvent {
  userId: string;
  targetId: string;
  action: SwipeAction;
  dwellTimeMs: number;
  scrollVelocity: number;
  timestamp?: number;
}

/** Reasons why a compatibility bonus was awarded. */
export type CompatibilityReason = 'high-dwell' | 'careful-browsing' | 'superlike' | 'mutual-like';

/** Result returned from a single `process` call. */
export interface SwipeResult {
  userId: string;
  targetId: string;
  action: SwipeAction;
  dwellTimeMs: number;
  scrollVelocity: number;
  compatibilityDelta: number;
  reasons: CompatibilityReason[];
  cooldownApplied: boolean;
  cooldownExpiresAt: number | null;
  viewer: { rating: number; ratingDeviation: number };
  target: { rating: number; ratingDeviation: number };
  mutualMatch: boolean;
}

/** Configuration for `SwipeProcessor`. */
export interface SwipeProcessorOptions {
  /** Window size in milliseconds for the rapid-skip detector. Default 10 000. */
  rapidSkipWindowMs?: number;
  /** Number of skips inside the window that triggers a cooldown. Default 5. */
  rapidSkipThreshold?: number;
  /** Duration of the cooldown penalty in milliseconds. Default 30 000. */
  cooldownMs?: number;
  /** Dwell threshold in milliseconds for the high-interest bonus. Default 3000. */
  highDwellThresholdMs?: number;
  /** Velocity threshold in px/s for the careful-browsing bonus. Default 100. */
  carefulBrowsingVelocity?: number;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

interface SkipTrace {
  timestamps: number[];
  cooldownUntil: number;
}

/** Low-level service that turns raw swipe events into structured signals. */
export class SwipeProcessor {
  private readonly elo: EloService;
  private readonly rapidSkipWindowMs: number;
  private readonly rapidSkipThreshold: number;
  private readonly cooldownMs: number;
  private readonly highDwellThresholdMs: number;
  private readonly carefulBrowsingVelocity: number;
  private readonly now: () => number;

  private readonly skipTraces = new Map<string, SkipTrace>();
  /** For every (userId → targetId) we remember whether the user liked them. */
  private readonly likes = new Map<string, Set<string>>();

  constructor(elo: EloService, options: SwipeProcessorOptions = {}) {
    this.elo = elo;
    this.rapidSkipWindowMs = options.rapidSkipWindowMs ?? 10_000;
    this.rapidSkipThreshold = options.rapidSkipThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.highDwellThresholdMs = options.highDwellThresholdMs ?? 3000;
    this.carefulBrowsingVelocity = options.carefulBrowsingVelocity ?? 100;
    this.now = options.now ?? Date.now;
  }

  /**
   * Process a swipe event.
   *
   * @throws If `userId === targetId` (self-swipe) or if the action is unknown.
   */
  process(event: SwipeEvent): SwipeResult {
    if (event.userId === event.targetId) {
      throw new Error('cannot swipe on self');
    }
    if (event.action !== 'like' && event.action !== 'skip' && event.action !== 'superlike') {
      throw new Error(`unknown swipe action: ${event.action}`);
    }
    if (event.dwellTimeMs < 0) {
      throw new Error('dwellTimeMs must be non-negative');
    }
    if (event.scrollVelocity < 0) {
      throw new Error('scrollVelocity must be non-negative');
    }

    const now = event.timestamp ?? this.now();
    const reasons: CompatibilityReason[] = [];
    let compatibilityDelta = 0;

    if (event.dwellTimeMs > this.highDwellThresholdMs) {
      compatibilityDelta += 2;
      reasons.push('high-dwell');
    }
    if (event.scrollVelocity < this.carefulBrowsingVelocity) {
      compatibilityDelta += 1;
      reasons.push('careful-browsing');
    }
    if (event.action === 'superlike') {
      compatibilityDelta += 5;
      reasons.push('superlike');
    }

    // Cooldown detection (only applies to skip events).
    let cooldownApplied = false;
    let cooldownExpiresAt: number | null = null;
    const trace = this.getTrace(event.userId);
    if (now < trace.cooldownUntil) {
      // Still in an existing cooldown – keep original expiry visible.
      cooldownApplied = false;
      cooldownExpiresAt = trace.cooldownUntil;
    }
    if (event.action === 'skip') {
      trace.timestamps.push(now);
      // Drop entries outside the window.
      const cutoff = now - this.rapidSkipWindowMs;
      while (trace.timestamps.length > 0 && trace.timestamps[0] < cutoff) {
        trace.timestamps.shift();
      }
      if (trace.timestamps.length >= this.rapidSkipThreshold && now >= trace.cooldownUntil) {
        trace.cooldownUntil = now + this.cooldownMs;
        cooldownApplied = true;
        cooldownExpiresAt = trace.cooldownUntil;
      }
    }

    // Like bookkeeping (superlike counts as a like for mutual detection).
    let mutualMatch = false;
    if (event.action === 'like' || event.action === 'superlike') {
      this.getLikes(event.userId).add(event.targetId);
      if (this.getLikes(event.targetId).has(event.userId)) {
        mutualMatch = true;
        compatibilityDelta += 3;
        reasons.push('mutual-like');
      }
    }

    // Translate the swipe action into a symmetric Glicko score for the viewer.
    //   like       → viewer "won" (they discovered a hit). score = 1
    //   superlike  → still score = 1 with extra compatibility above.
    //   skip       → viewer "lost" interest. score = 0 for viewer, 1 for target
    //                so the target still gains rating when many people pass.
    const viewerScore = event.action === 'skip' ? 0 : 1;
    const { a, b } = this.elo.headToHead(event.userId, event.targetId, viewerScore);

    return {
      userId: event.userId,
      targetId: event.targetId,
      action: event.action,
      dwellTimeMs: event.dwellTimeMs,
      scrollVelocity: event.scrollVelocity,
      compatibilityDelta,
      reasons,
      cooldownApplied,
      cooldownExpiresAt,
      viewer: { rating: a.after.rating, ratingDeviation: a.after.ratingDeviation },
      target: { rating: b.after.rating, ratingDeviation: b.after.ratingDeviation },
      mutualMatch
    };
  }

  /** Return true if the user is currently in a skip cooldown. */
  isInCooldown(userId: string): boolean {
    const trace = this.skipTraces.get(userId);
    if (!trace) return false;
    return this.now() < trace.cooldownUntil;
  }

  /** Return the cooldown expiry timestamp (ms) for a user, or null. */
  getCooldownExpiry(userId: string): number | null {
    const trace = this.skipTraces.get(userId);
    if (!trace || trace.cooldownUntil <= this.now()) return null;
    return trace.cooldownUntil;
  }

  /** Return every user this user has liked. */
  getLikesFrom(userId: string): string[] {
    return Array.from(this.getLikes(userId));
  }

  /** Return the mutual-match pairs for a user. */
  getMutualMatches(userId: string): string[] {
    const mine = this.getLikes(userId);
    const result: string[] = [];
    for (const other of mine) {
      if (this.getLikes(other).has(userId)) {
        result.push(other);
      }
    }
    return result;
  }

  /** Remove stale skip traces to bound memory growth. */
  prune(): void {
    const now = this.now();
    const cutoff = now - this.rapidSkipWindowMs;
    for (const [userId, trace] of this.skipTraces.entries()) {
      while (trace.timestamps.length > 0 && trace.timestamps[0] < cutoff) {
        trace.timestamps.shift();
      }
      if (trace.timestamps.length === 0 && trace.cooldownUntil <= now) {
        this.skipTraces.delete(userId);
      }
    }
  }

  private getTrace(userId: string): SkipTrace {
    let t = this.skipTraces.get(userId);
    if (!t) {
      t = { timestamps: [], cooldownUntil: 0 };
      this.skipTraces.set(userId, t);
    }
    return t;
  }

  private getLikes(userId: string): Set<string> {
    let s = this.likes.get(userId);
    if (!s) {
      s = new Set();
      this.likes.set(userId, s);
    }
    return s;
  }
}
