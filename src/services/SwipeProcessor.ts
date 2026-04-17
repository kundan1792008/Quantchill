/**
 * SwipeProcessor – behavioral swipe event processor for Quantchill.
 *
 * Processes rich swipe events that carry behavioral signals beyond the basic
 * outcome (like/skip/superlike):
 *
 *  - `dwellTimeMs`      – how long the viewer looked at the card.
 *  - `scrollVelocity`   – px/s at the moment the swipe was initiated.
 *
 * These signals feed into a per-pair compatibility score and into ELO
 * updates via EloService.
 *
 * Behavioral rules (from spec):
 *  - dwellTimeMs > 3000 → high interest signal (+2 compatibility).
 *  - scrollVelocity < 100 px/s → careful browsing (+1 compatibility).
 *  - Rapid consecutive skips (> 5 in 10 s) → cooldown penalty applied.
 */

import { EloService } from './EloService';

// ─── Constants ────────────────────────────────────────────────────────────────

const DWELL_HIGH_INTEREST_MS = 3_000;
const DWELL_COMPATIBILITY_BONUS = 2;

const SCROLL_CAREFUL_PX_PER_S = 100;
const SCROLL_COMPATIBILITY_BONUS = 1;

const RAPID_SKIP_THRESHOLD = 5;        // skips
const RAPID_SKIP_WINDOW_MS = 10_000;   // in this many ms
const COOLDOWN_DURATION_MS = 30_000;   // penalty duration

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single swipe event emitted from the client. */
export interface SwipeEvent {
  userId: string;
  targetId: string;
  action: 'like' | 'skip' | 'superlike';
  dwellTimeMs: number;
  scrollVelocity: number;
}

/** Processed result returned after a swipe event. */
export interface SwipeProcessResult {
  userId: string;
  targetId: string;
  action: SwipeEvent['action'];
  compatibilityDelta: number;
  /** Updated ELO rating for the swiping user. */
  userRating: number;
  /** Updated ELO rating for the target user. */
  targetRating: number;
  /** True if a cooldown penalty was applied to the swiping user. */
  cooldownApplied: boolean;
  /** Timestamp the event was processed (ms since epoch). */
  processedAt: number;
}

// ─── SwipeProcessor ───────────────────────────────────────────────────────────

/**
 * SwipeProcessor maintains per-user behavioral state and delegates ELO
 * mutations to EloService.
 */
export class SwipeProcessor {
  /** userId → timestamps of recent skips (for rapid-skip detection). */
  private readonly recentSkips = new Map<string, number[]>();

  /** userId → cooldown expiry timestamp (ms since epoch). */
  private readonly cooldowns = new Map<string, number>();

  constructor(private readonly eloService: EloService) {}

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Process a single swipe event.
   *
   * Steps:
   *  1. Compute behavioural compatibility delta from dwell / scroll signals.
   *  2. Check for rapid-skip cooldown; if triggered, skip ELO update.
   *  3. Otherwise update ELO via EloService.
   *  4. Return the processed result.
   */
  process(event: SwipeEvent): SwipeProcessResult {
    const { userId, targetId, action, dwellTimeMs, scrollVelocity } = event;
    const now = Date.now();

    // 1. Behavioural compatibility delta.
    let compatibilityDelta = 0;
    if (dwellTimeMs > DWELL_HIGH_INTEREST_MS) {
      compatibilityDelta += DWELL_COMPATIBILITY_BONUS;
    }
    if (scrollVelocity < SCROLL_CAREFUL_PX_PER_S) {
      compatibilityDelta += SCROLL_COMPATIBILITY_BONUS;
    }

    // 2. Cooldown check.
    let cooldownApplied = this.isInCooldown(userId, now);
    if (action === 'skip' && !cooldownApplied) {
      cooldownApplied = this.recordSkipAndCheckCooldown(userId, now);
    }

    // 3. ELO update (skip if user is in cooldown).
    let userRating = this.eloService.getRating(userId);
    let targetRating = this.eloService.getRating(targetId);

    if (!cooldownApplied) {
      const result = this.eloService.processSwipe(userId, targetId, action);
      userRating = result.viewerResult.newRating;
      targetRating = result.subjectResult.newRating;
    }

    return {
      userId,
      targetId,
      action,
      compatibilityDelta,
      userRating,
      targetRating,
      cooldownApplied,
      processedAt: now
    };
  }

  /**
   * Return true if the given user is currently in a skip cooldown.
   */
  isInCooldown(userId: string, now = Date.now()): boolean {
    const expiry = this.cooldowns.get(userId);
    if (expiry === undefined) return false;
    if (now >= expiry) {
      this.cooldowns.delete(userId);
      return false;
    }
    return true;
  }

  /**
   * Return the cooldown expiry timestamp for a user, or null if not in
   * cooldown.
   */
  cooldownExpiry(userId: string): number | null {
    const expiry = this.cooldowns.get(userId);
    if (expiry === undefined) return null;
    if (Date.now() >= expiry) {
      this.cooldowns.delete(userId);
      return null;
    }
    return expiry;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Record a skip event for a user and check whether the rapid-skip threshold
   * has been exceeded within the sliding window.
   *
   * @returns true if a new cooldown was just applied.
   */
  private recordSkipAndCheckCooldown(userId: string, now: number): boolean {
    // Initialise or retrieve the skip timestamps list.
    let timestamps = this.recentSkips.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.recentSkips.set(userId, timestamps);
    }

    // Prune timestamps outside the sliding window.
    const windowStart = now - RAPID_SKIP_WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0]! < windowStart) {
      timestamps.shift();
    }

    timestamps.push(now);

    if (timestamps.length > RAPID_SKIP_THRESHOLD) {
      this.cooldowns.set(userId, now + COOLDOWN_DURATION_MS);
      // Reset the skip counter after cooldown is applied.
      this.recentSkips.set(userId, []);
      return true;
    }

    return false;
  }
}
