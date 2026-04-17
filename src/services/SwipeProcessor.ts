/**
 * SwipeProcessor — behavioural-signal-aware swipe ingest pipeline.
 *
 * A single event is a user's binary reaction to another user's profile card:
 *   `{ userId, targetId, action, dwellTimeMs, scrollVelocity }`
 *
 * Effects:
 *   - Glicko-2 rating update via the injected `GlickoEngine`.
 *   - Compatibility score adjustments based on micro-signals:
 *       * dwellTimeMs > 3000ms        → +2 compatibility ("lingering" interest)
 *       * scrollVelocity < 100 px/s   → +1 compatibility ("careful browsing")
 *       * superlike                    → +5 compatibility baseline
 *   - Rapid-skip cooldown: if a user posts >5 skips in any 10 s sliding window,
 *     a time-based penalty is levied, temporarily suppressing their
 *     recommendations.
 *
 * Compatibility adjustments are emitted as `CompatibilitySignal` events so the
 * `InterestGraph` can update its edges. The processor does **not** itself
 * mutate the interest graph — dependency-injection keeps the layers testable.
 */

import { GlickoEngine } from './GlickoEngine';

export type SwipeAction = 'like' | 'skip' | 'superlike';

export interface SwipeEvent {
  userId: string;
  targetId: string;
  action: SwipeAction;
  dwellTimeMs: number;
  scrollVelocity: number;
  /** Optional client-reported wall-clock timestamp (ms). */
  occurredAt?: number;
}

export interface CompatibilitySignal {
  userId: string;
  targetId: string;
  /** +N or -N compatibility delta applied to the user→target edge. */
  delta: number;
  /** Human-readable tags explaining the delta; useful for logs. */
  reasons: string[];
  /** Whether this signal should be consumed as a positive edge update. */
  positive: boolean;
}

export interface SwipeProcessingResult {
  accepted: boolean;
  event: SwipeEvent;
  compatibility: CompatibilitySignal;
  viewerRating: number;
  targetRating: number;
  /** If set, the swipe was rejected because the user is in cooldown. */
  rejection?: {
    reason: 'rapid-skip-cooldown';
    until: number;
    remainingMs: number;
  };
}

export interface SwipeProcessorConfig {
  dwellThresholdMs: number;    // default 3000
  slowScrollThreshold: number; // default 100 px/s
  rapidSkipCount: number;      // default 5
  rapidSkipWindowMs: number;   // default 10_000
  rapidSkipPenaltyMs: number;  // default 60_000
  /** Maximum events retained per user for rapid-skip detection. */
  windowBufferSize: number;    // default 64
}

export const DEFAULT_SWIPE_CONFIG: SwipeProcessorConfig = {
  dwellThresholdMs: 3_000,
  slowScrollThreshold: 100,
  rapidSkipCount: 5,
  rapidSkipWindowMs: 10_000,
  rapidSkipPenaltyMs: 60_000,
  windowBufferSize: 64
};

interface UserState {
  recentSkipTimestamps: number[];
  cooldownUntil: number;
}

/**
 * The processor is stateful: it tracks each user's rolling skip window and
 * current cooldown expiry. All reads/writes are O(1) amortised.
 */
export class SwipeProcessor {
  private readonly config: SwipeProcessorConfig;
  private readonly state = new Map<string, UserState>();
  private readonly listeners = new Set<(sig: CompatibilitySignal) => void>();
  private readonly now: () => number;

  constructor(
    private readonly glicko: GlickoEngine,
    overrides: Partial<SwipeProcessorConfig> = {},
    nowFn: () => number = () => Date.now()
  ) {
    this.config = { ...DEFAULT_SWIPE_CONFIG, ...overrides };
    this.now = nowFn;
  }

  /** Register a listener for compatibility signals (e.g., the InterestGraph). */
  onCompatibility(listener: (sig: CompatibilitySignal) => void): void {
    this.listeners.add(listener);
  }

  /** Detach a compatibility listener. */
  offCompatibility(listener: (sig: CompatibilitySignal) => void): void {
    this.listeners.delete(listener);
  }

  /** Returns true if the user is currently in rapid-skip cooldown. */
  isInCooldown(userId: string): boolean {
    const state = this.state.get(userId);
    if (!state) return false;
    return state.cooldownUntil > this.now();
  }

  /** Read the cooldown expiry timestamp (0 if none). */
  cooldownUntil(userId: string): number {
    return this.state.get(userId)?.cooldownUntil ?? 0;
  }

  /** Process a single swipe, returning the full accounting of its effects. */
  process(event: SwipeEvent): SwipeProcessingResult {
    if (event.userId === event.targetId) {
      throw new Error('SwipeProcessor: cannot swipe on self');
    }
    if (!Number.isFinite(event.dwellTimeMs) || event.dwellTimeMs < 0) {
      throw new Error('SwipeProcessor: dwellTimeMs must be a non-negative finite number');
    }
    if (!Number.isFinite(event.scrollVelocity) || event.scrollVelocity < 0) {
      throw new Error('SwipeProcessor: scrollVelocity must be a non-negative finite number');
    }
    if (event.action !== 'like' && event.action !== 'skip' && event.action !== 'superlike') {
      throw new Error(`SwipeProcessor: unknown action ${String(event.action)}`);
    }

    const t = event.occurredAt ?? this.now();
    const state = this.ensureState(event.userId);

    // Short-circuit if the user is still in cooldown.
    if (state.cooldownUntil > t) {
      const viewer = this.glicko.getPlayer(event.userId);
      const target = this.glicko.getPlayer(event.targetId);
      return {
        accepted: false,
        event,
        compatibility: {
          userId: event.userId,
          targetId: event.targetId,
          delta: 0,
          reasons: ['cooldown-active'],
          positive: false
        },
        viewerRating: viewer.rating,
        targetRating: target.rating,
        rejection: {
          reason: 'rapid-skip-cooldown',
          until: state.cooldownUntil,
          remainingMs: state.cooldownUntil - t
        }
      };
    }

    // Glicko-2 score mapping:
    //   like      → symmetric win  (viewer 0.5 — marginal, target 1.0)
    //   superlike → strong win     (viewer 1.0, target 1.0)
    //   skip      → target loses   (viewer 0.5, target 0.0)
    const score = this.scoreForAction(event.action);
    const viewerBefore = this.glicko.getPlayer(event.userId);
    const targetBefore = this.glicko.getPlayer(event.targetId);

    this.glicko.update(event.userId, [
      {
        opponentRating: targetBefore.rating,
        opponentRatingDeviation: targetBefore.ratingDeviation,
        score: score.viewer
      }
    ]);
    this.glicko.update(event.targetId, [
      {
        opponentRating: viewerBefore.rating,
        opponentRatingDeviation: viewerBefore.ratingDeviation,
        score: score.target
      }
    ]);

    // Compute compatibility signal.
    const compatibility = this.buildCompatibilitySignal(event);
    for (const listener of this.listeners) listener(compatibility);

    // Rapid-skip detection (only for skip actions).
    if (event.action === 'skip') {
      this.recordSkip(state, t);
    } else {
      // Non-skip events slowly drain the window (makes the signal responsive).
      state.recentSkipTimestamps = state.recentSkipTimestamps.filter(
        (ts) => t - ts <= this.config.rapidSkipWindowMs
      );
    }

    const viewerAfter = this.glicko.getPlayer(event.userId);
    const targetAfter = this.glicko.getPlayer(event.targetId);

    return {
      accepted: true,
      event,
      compatibility,
      viewerRating: viewerAfter.rating,
      targetRating: targetAfter.rating
    };
  }

  /** Reset internal state (for tests). */
  reset(): void {
    this.state.clear();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private ensureState(userId: string): UserState {
    let s = this.state.get(userId);
    if (!s) {
      s = { recentSkipTimestamps: [], cooldownUntil: 0 };
      this.state.set(userId, s);
    }
    return s;
  }

  private scoreForAction(action: SwipeAction): { viewer: 0 | 0.5 | 1; target: 0 | 0.5 | 1 } {
    switch (action) {
      case 'like':
        return { viewer: 0.5, target: 1 };
      case 'superlike':
        return { viewer: 1, target: 1 };
      case 'skip':
        return { viewer: 0.5, target: 0 };
    }
  }

  private buildCompatibilitySignal(event: SwipeEvent): CompatibilitySignal {
    const reasons: string[] = [];
    let delta = 0;
    let positive = false;

    if (event.action === 'like') {
      delta += 3;
      reasons.push('like');
      positive = true;
    } else if (event.action === 'superlike') {
      delta += 5;
      reasons.push('superlike');
      positive = true;
    } else if (event.action === 'skip') {
      delta -= 2;
      reasons.push('skip');
      positive = false;
    }

    if (event.dwellTimeMs > this.config.dwellThresholdMs) {
      delta += 2;
      reasons.push('long-dwell');
      if (delta > 0) positive = true;
    }

    if (event.scrollVelocity < this.config.slowScrollThreshold) {
      delta += 1;
      reasons.push('careful-browsing');
      if (delta > 0) positive = true;
    }

    // Clamp compatibility deltas into a sensible range.
    if (delta > 10) delta = 10;
    if (delta < -10) delta = -10;

    return { userId: event.userId, targetId: event.targetId, delta, reasons, positive };
  }

  private recordSkip(state: UserState, t: number): void {
    state.recentSkipTimestamps.push(t);
    if (state.recentSkipTimestamps.length > this.config.windowBufferSize) {
      state.recentSkipTimestamps.splice(
        0,
        state.recentSkipTimestamps.length - this.config.windowBufferSize
      );
    }
    // Drop expired entries from the window.
    state.recentSkipTimestamps = state.recentSkipTimestamps.filter(
      (ts) => t - ts <= this.config.rapidSkipWindowMs
    );

    if (state.recentSkipTimestamps.length > this.config.rapidSkipCount) {
      state.cooldownUntil = t + this.config.rapidSkipPenaltyMs;
      state.recentSkipTimestamps = [];
    }
  }
}
