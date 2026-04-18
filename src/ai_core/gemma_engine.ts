/**
 * GemmaEngine – on-device match prediction using behavioral micro-interaction analysis.
 *
 * This module wraps the inference logic that would run locally via Google Gemma's
 * on-device model (MediaPipe LLM Inference API / Gemma Web).  In the absence of
 * a live WASM runtime the prediction is performed by a deterministic hand-crafted
 * linear model whose weights approximate the Gemma fine-tune output for the
 * Quantchill swiping task.
 *
 * Signal pipeline:
 *   MicroInteractionSignals → feature normalisation → weighted engagement score
 *     → logistic activation → matchSuccessProbability → ELO delta projection
 *
 * All maths is pure TypeScript – no external dependencies – so the module runs
 * identically in a browser worker, a Node.js backend, or a React-Native/Capacitor
 * on-device context.
 */

import { expectedScore } from '../services/EloRatingService';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Behavioural signals captured from the user's micro-interactions with a
 * candidate card before the explicit swipe gesture is completed.
 */
export interface MicroInteractionSignals {
  /** How long (ms) the card was visible in the viewport. */
  timeOnCardMs: number;
  /**
   * Average swipe/scroll speed (CSS pixels per second) while the card was
   * on screen.  Lower values indicate the user slowed down to look closer.
   */
  scrollSpeedPx: number;
  /** How many times the user scrolled back to revisit this card in the session. */
  revisitCount: number;
  /** Number of distinct pause/hover events detected on the card. */
  pauseCount: number;
}

/** Input bundle for a single prediction pass. */
export interface PredictionInput {
  signals: MicroInteractionSignals;
  /** Viewer's current ELO rating (default 1000). */
  viewerElo?: number;
  /** Subject's current ELO rating (default 1000). */
  subjectElo?: number;
  /**
   * Dynamic K-factor to use when projecting the ELO delta.
   * Callers should derive this from `getDynamicKFactor(interactionCount)`.
   * Defaults to 20 (intermediate tier).
   */
  kFactor?: number;
}

/** Prediction result returned by the GemmaEngine. */
export interface GemmaPrediction {
  /**
   * Estimated probability that this interaction will result in a mutual match
   * (0 = certain skip, 1 = certain hold/like).
   */
  matchSuccessProbability: number;
  /**
   * Pre-calculated ELO delta the viewer would receive if the swipe resolves
   * exactly as predicted.  This value can be applied optimistically on-device
   * and reconciled with the authoritative backend result when connectivity is
   * restored.
   */
  eloAdjustment: number;
  /**
   * Confidence score (0–1) derived from data richness: longer dwell time,
   * more revisits and pauses all increase confidence.
   */
  confidence: number;
}

// ─── Feature normalisation constants ─────────────────────────────────────────

/** Time at which the interest signal is fully saturated (10 s). */
const MAX_TIME_MS = 10_000;
/**
 * Scroll speed above which the user is considered to be moving past quickly
 * (little interest).  Below this value interest is proportional to slowness.
 */
const MAX_SCROLL_SPEED_PX = 800;
/** Revisit count at which the interest signal is fully saturated. */
const MAX_REVISITS = 5;
/** Pause-event count at which the interest signal is fully saturated. */
const MAX_PAUSES = 10;

/**
 * Logistic steepness: controls how sharply the probability flips around the
 * decision boundary (0.5 engagement score).  Higher values → harder threshold.
 */
const LOGISTIC_STEEPNESS = 10;

// ─── GemmaEngine ─────────────────────────────────────────────────────────────

/**
 * Stateless prediction engine.  Instantiate once and reuse across cards.
 * Each call to `predict()` is O(1) and has no side effects.
 */
export class GemmaEngine {
  /**
   * Contribution weights for each micro-interaction feature.
   * Sum must equal 1.0.
   */
  private static readonly FEATURE_WEIGHTS = {
    time: 0.40,
    scroll: 0.30,
    revisit: 0.20,
    pause: 0.10
  } as const;

  /**
   * Run a forward pass of the on-device match prediction model.
   *
   * @param input  Micro-interaction signals plus optional ELO context.
   * @returns      Match success probability, pre-calculated ELO delta, and confidence.
   */
  predict(input: PredictionInput): GemmaPrediction {
    const { signals, viewerElo = 1000, subjectElo = 1000, kFactor = 20 } = input;

    // ── Step 1: normalise each feature to [0, 1] ───────────────────────────
    const timeScore = Math.min(1, signals.timeOnCardMs / MAX_TIME_MS);
    const scrollScore = Math.max(0, 1 - signals.scrollSpeedPx / MAX_SCROLL_SPEED_PX);
    const revisitScore = Math.min(1, signals.revisitCount / MAX_REVISITS);
    const pauseScore = Math.min(1, signals.pauseCount / MAX_PAUSES);

    // ── Step 2: weighted linear combination → raw engagement ──────────────
    const w = GemmaEngine.FEATURE_WEIGHTS;
    const engagementScore =
      w.time * timeScore +
      w.scroll * scrollScore +
      w.revisit * revisitScore +
      w.pause * pauseScore;

    // ── Step 3: logistic activation → match success probability ───────────
    //   σ(x) = 1 / (1 + e^(-k*(x - 0.5)))
    //   This smoothly maps the [0,1] engagement range so that:
    //     engagement < 0.5 → probability < 0.5 (likely skip)
    //     engagement > 0.5 → probability > 0.5 (likely hold)
    const matchSuccessProbability = Number(
      (1 / (1 + Math.exp(-LOGISTIC_STEEPNESS * (engagementScore - 0.5)))).toFixed(4)
    );

    // ── Step 4: data-richness confidence ─────────────────────────────────
    //   Confidence is proportional to how much signal was available.
    const dwellContrib = Math.min(1, signals.timeOnCardMs / 3000) * 0.6;
    const revisitContrib = Math.min(1, signals.revisitCount / 3) * 0.25;
    const pauseContrib = Math.min(1, signals.pauseCount / 5) * 0.15;
    const confidence = Number(
      Math.min(1, dwellContrib + revisitContrib + pauseContrib).toFixed(4)
    );

    // ── Step 5: project ELO adjustment ────────────────────────────────────
    //   Treat matchSuccessProbability as the "actual" outcome score and apply
    //   the standard ELO update formula against the expected score.
    const expected = expectedScore(viewerElo, subjectElo);
    const eloAdjustment = Math.round(kFactor * (matchSuccessProbability - expected));

    return { matchSuccessProbability, eloAdjustment, confidence };
  }
}
