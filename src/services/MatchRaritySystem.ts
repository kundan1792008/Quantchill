/**
 * MatchRaritySystem – compute a neutral compatibility score and tier from
 * consented micro-interaction signals (the same shape used elsewhere in the
 * codebase: `timeOnCardMs`, `scrollSpeedPx`, `revisitCount`, `pauseCount`).
 *
 * Design principles (explicit non-goals):
 *   - No Bronze / Silver / Gold / Diamond gacha framing. Tiers are neutral
 *     labels: low | medium | high | very_high.
 *   - No confetti / FOMO animation signal from the server. The server
 *     returns a number and a label. Presentation is the client's problem
 *     and SHOULD be subtle.
 *   - No paywall gating. The compute function does not accept a payment
 *     tier, cannot be given one, and returns the same result regardless of
 *     subscription state. If monetization is desired, gate non-essential
 *     features (advanced filters, etc.) in a different module.
 *   - No simulated BCI / eye-tracking inputs. Inputs are limited to
 *     user-consented micro-interaction counters already produced on-device.
 */

/**
 * Consented micro-interaction signals produced on-device. These are the same
 * fields GemmaEngine consumes. Every field is optional so callers can pass
 * whatever they have; missing fields are treated as neutral.
 */
export interface CompatibilitySignals {
  /** Total time the viewer spent on this card in ms. */
  timeOnCardMs?: number;
  /** Average scroll speed in px/s – high speed indicates low engagement. */
  scrollSpeedPx?: number;
  /** Number of times the viewer returned to this card. */
  revisitCount?: number;
  /** Number of discrete pause/dwell events on the card. */
  pauseCount?: number;
}

/** Neutral compatibility tiers. No rarity / gacha framing. */
export type CompatibilityTier = 'low' | 'medium' | 'high' | 'very_high';

export interface CompatibilityResult {
  /** Compatibility score in [0, 1]. Higher = stronger signal of interest. */
  score: number;
  /** Neutral tier bucket derived from the score. */
  tier: CompatibilityTier;
}

// ─── Tunables (exported so tests can reference thresholds) ───────────────────

/** Time on card (ms) that maps to a fully saturated `timeOnCard` sub-score. */
export const TIME_ON_CARD_SATURATION_MS = 8_000;

/**
 * Scroll speed (px/s) at or above which the `calm` sub-score is 0.
 * Below this, the sub-score scales linearly to 1 at 0 px/s.
 */
export const SCROLL_SPEED_CEILING_PX_S = 2_000;

/**
 * Revisit count at which the `revisit` sub-score saturates.
 *
 * Intuition: a first revisit is a strong signal the viewer is interested; a
 * second revisit confirms deliberate consideration; a third is near-certain
 * interest. Beyond 3 we have no additional information worth encoding, so
 * we saturate to avoid letting a handful of "stuck on one profile" users
 * dominate the signal distribution.
 */
export const REVISIT_SATURATION = 3;

/**
 * Pause count at which the `pause` sub-score saturates. Slightly higher than
 * revisit saturation because pauses are cheaper (a single dwell can produce
 * multiple pause events), so we require a few more before declaring a
 * maximal signal.
 */
export const PAUSE_SATURATION = 4;

/**
 * Weights for each sub-signal. Sum to 1 so the combined score is in [0, 1].
 * Heuristic defaults; product can override via {@link computeCompatibility}.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  timeOnCard: 0.4,
  calm: 0.2,
  revisit: 0.25,
  pause: 0.15
});

/** Tier boundaries. Chosen to be evenly spaced and easy to reason about. */
export const TIER_THRESHOLDS = Object.freeze({
  medium: 0.3,
  high: 0.6,
  veryHigh: 0.8
});

export type SignalWeights = typeof DEFAULT_WEIGHTS;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Clamp a value to [0, 1]. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Map a compatibility score to a neutral tier label.
 *
 * Thresholds:
 *   score < 0.3  → low
 *   score < 0.6  → medium
 *   score < 0.8  → high
 *   score ≥ 0.8  → very_high
 */
export function scoreToTier(score: number): CompatibilityTier {
  const s = clamp01(score);
  if (s < TIER_THRESHOLDS.medium) return 'low';
  if (s < TIER_THRESHOLDS.high) return 'medium';
  if (s < TIER_THRESHOLDS.veryHigh) return 'high';
  return 'very_high';
}

// ─── Sub-signal calculators ──────────────────────────────────────────────────

function timeOnCardScore(timeOnCardMs: number | undefined): number {
  if (timeOnCardMs === undefined || timeOnCardMs <= 0) return 0;
  return clamp01(timeOnCardMs / TIME_ON_CARD_SATURATION_MS);
}

/**
 * Calm sub-score: slower scrolling ⇒ higher engagement. Linear from 1 at
 * 0 px/s down to 0 at {@link SCROLL_SPEED_CEILING_PX_S} px/s.
 */
function calmScore(scrollSpeedPx: number | undefined): number {
  if (scrollSpeedPx === undefined) return 0.5; // neutral when unknown
  const clampedSpeed = Math.max(0, scrollSpeedPx);
  return clamp01(1 - clampedSpeed / SCROLL_SPEED_CEILING_PX_S);
}

function revisitScore(revisitCount: number | undefined): number {
  if (revisitCount === undefined || revisitCount <= 0) return 0;
  return clamp01(revisitCount / REVISIT_SATURATION);
}

function pauseScore(pauseCount: number | undefined): number {
  if (pauseCount === undefined || pauseCount <= 0) return 0;
  return clamp01(pauseCount / PAUSE_SATURATION);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute a compatibility result from consented micro-interaction signals.
 *
 * Intentionally side-effect free and does not accept any user identity,
 * subscription tier, or payment context. This function will never gate its
 * output on monetization state.
 */
export function computeCompatibility(
  signals: CompatibilitySignals,
  weights: SignalWeights = DEFAULT_WEIGHTS
): CompatibilityResult {
  const wSum = weights.timeOnCard + weights.calm + weights.revisit + weights.pause;
  if (!(wSum > 0)) {
    throw new Error('weights must sum to a positive number');
  }

  const t = timeOnCardScore(signals.timeOnCardMs);
  const c = calmScore(signals.scrollSpeedPx);
  const r = revisitScore(signals.revisitCount);
  const p = pauseScore(signals.pauseCount);

  const raw =
    t * weights.timeOnCard + c * weights.calm + r * weights.revisit + p * weights.pause;
  const score = clamp01(raw / wSum);
  return { score, tier: scoreToTier(score) };
}

/**
 * Thin service wrapper. Present for architectural symmetry with the other
 * `*Service` classes in this repo; the stateless `computeCompatibility`
 * function is the real API.
 */
export class MatchRaritySystem {
  constructor(private readonly weights: SignalWeights = DEFAULT_WEIGHTS) {}

  compute(signals: CompatibilitySignals): CompatibilityResult {
    return computeCompatibility(signals, this.weights);
  }
}
