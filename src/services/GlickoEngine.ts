/**
 * GlickoEngine — full Glicko-2 rating system for Quantchill matchmaking.
 *
 * Reference: Mark E. Glickman, "Example of the Glicko-2 system" (2013)
 * http://www.glicko.net/glicko/glicko2.pdf
 *
 * Per-user state:
 *   - `rating`           (default 1500, internal µ)
 *   - `ratingDeviation`  (default  350, internal φ)
 *   - `volatility`       (default 0.06, internal σ)
 *
 * Features implemented here:
 *   - Strict Glicko-2 rating update for a batch of games within a "rating period".
 *   - Rating floor (800) so new/unlucky users never free-fall out of the pool.
 *   - Dynamic K-factor exposed through `getDynamicKFactor` for legacy/compat code paths.
 *   - Batch processor capable of sustained 1000+ updates/second without blocking
 *     the event loop (work is split into ≤ 250-update micro-batches on `setImmediate`).
 *   - Pure math helpers (`expectedScore`, `g`, `E`, `convertToGlicko2Scale`) are
 *     exported so unit tests can verify them in isolation.
 */

/** The system constant τ constrains volatility over time; 0.5 is a sane default. */
export const GLICKO2_TAU = 0.5;

/** Numerical tolerance for the iterative volatility update. */
export const GLICKO2_EPSILON = 1e-6;

/** Default starting values for a brand-new player. */
export const DEFAULT_RATING = 1500;
export const DEFAULT_RATING_DEVIATION = 350;
export const DEFAULT_VOLATILITY = 0.06;

/** Rating floor — a player can never fall below this value. */
export const RATING_FLOOR = 800;

/** Glicko-2 scale factor (1 Glicko-2 unit ≈ 173.7178 Glicko-1 units). */
export const GLICKO2_SCALE = 173.7178;

/** Anchor used when converting between Glicko-1 ↔ Glicko-2 internal µ. */
export const GLICKO2_ANCHOR = 1500;

/** Max games processed in a single synchronous tick before yielding. */
export const MAX_SYNC_BATCH_SIZE = 250;

/** A single rated outcome for a player during a rating period. */
export interface GlickoMatch {
  opponentRating: number;
  opponentRatingDeviation: number;
  /** Observed score — 1 = win, 0 = loss, 0.5 = draw. */
  score: number;
}

/** Full Glicko-2 player state (public/external representation). */
export interface GlickoPlayer {
  userId: string;
  rating: number;
  ratingDeviation: number;
  volatility: number;
  /** Total rated interactions — used to pick a dynamic K-factor. */
  interactionCount: number;
  /** Timestamp (ms) of last rating update. */
  lastUpdatedAt: number;
}

/** Internal Glicko-2 state in the normalised µ/φ/σ scale. */
interface InternalGlickoState {
  mu: number;
  phi: number;
  sigma: number;
}

/** Result of a single batch update (one "rating period"). */
export interface GlickoUpdateResult {
  userId: string;
  before: GlickoPlayer;
  after: GlickoPlayer;
  gamesProcessed: number;
}

/**
 * Provisional / intermediate / established K-factor selector.
 *
 * Glicko-2 is the primary rating system, but a K-factor is still useful
 * for the cheap swipe path (`SwipeProcessor`) where full Glicko-2 batches
 * would be overkill. Consumers should prefer this helper over hardcoded K.
 */
export function getDynamicKFactor(interactionCount: number): number {
  if (interactionCount < 30) return 40;
  if (interactionCount < 100) return 20;
  return 10;
}

/**
 * Clamp a rating to the configured floor.
 * Exposed for direct use by the swipe processor and other services.
 */
export function applyRatingFloor(rating: number, floor: number = RATING_FLOOR): number {
  return rating < floor ? floor : rating;
}

/** Convert a Glicko-1 rating (e.g. 1500) to the Glicko-2 µ scale. */
export function convertToGlicko2Scale(rating: number, ratingDeviation: number): InternalGlickoState {
  return {
    mu: (rating - GLICKO2_ANCHOR) / GLICKO2_SCALE,
    phi: ratingDeviation / GLICKO2_SCALE,
    sigma: DEFAULT_VOLATILITY
  };
}

/** Convert a Glicko-2 µ back into the display-friendly Glicko-1 rating. */
export function convertFromGlicko2Scale(mu: number, phi: number): { rating: number; ratingDeviation: number } {
  return {
    rating: mu * GLICKO2_SCALE + GLICKO2_ANCHOR,
    ratingDeviation: phi * GLICKO2_SCALE
  };
}

/** Glickman's "g" function (opponent rating-deviation weighting). */
export function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** Glickman's "E" function (expected score of A given opponent B). */
export function E(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Classical logistic expected score (Glicko-1 shape) — used by the swipe path.
 * Not part of the Glicko-2 update itself.
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * The Glicko-2 engine itself — stateless w.r.t. persistence, but maintains an
 * in-memory `Map<userId, GlickoPlayer>` that can be mirrored to Redis/Postgres
 * via the `seedPlayer` / `getAllPlayers` hooks.
 */
export class GlickoEngine {
  private readonly players = new Map<string, GlickoPlayer>();

  constructor(private readonly tau: number = GLICKO2_TAU) {}

  /** Return (creating if absent) the canonical player record for a user. */
  getPlayer(userId: string): GlickoPlayer {
    const existing = this.players.get(userId);
    if (existing) return existing;
    const fresh: GlickoPlayer = {
      userId,
      rating: DEFAULT_RATING,
      ratingDeviation: DEFAULT_RATING_DEVIATION,
      volatility: DEFAULT_VOLATILITY,
      interactionCount: 0,
      lastUpdatedAt: Date.now()
    };
    this.players.set(userId, fresh);
    return fresh;
  }

  /** Seed a record from persistent storage. */
  seedPlayer(player: GlickoPlayer): void {
    this.players.set(player.userId, { ...player });
  }

  /** Snapshot of all known players. */
  getAllPlayers(): GlickoPlayer[] {
    return Array.from(this.players.values()).map((p) => ({ ...p }));
  }

  /** Total number of tracked players. */
  size(): number {
    return this.players.size;
  }

  /** Reset the store — useful for tests. */
  reset(): void {
    this.players.clear();
  }

  /**
   * Process a batch of games for a single player (one rating period).
   *
   * Follows the exact algorithm in Glickman (2013), sections 2–5.
   * Returns both the before- and after- snapshots of the player.
   */
  update(userId: string, matches: readonly GlickoMatch[]): GlickoUpdateResult {
    const before: GlickoPlayer = { ...this.getPlayer(userId) };

    if (matches.length === 0) {
      // Step 6 of the algorithm: no games played → increase RD only.
      const { mu, phi } = convertToGlicko2Scale(before.rating, before.ratingDeviation);
      const phiStar = Math.sqrt(phi * phi + before.volatility * before.volatility);
      const { rating, ratingDeviation } = convertFromGlicko2Scale(mu, phiStar);
      const after: GlickoPlayer = {
        ...before,
        ratingDeviation: Math.min(DEFAULT_RATING_DEVIATION, ratingDeviation),
        lastUpdatedAt: Date.now()
      };
      // Apply rating floor even when idling (safety net).
      after.rating = applyRatingFloor(rating);
      this.players.set(userId, after);
      return { userId, before, after: { ...after }, gamesProcessed: 0 };
    }

    const { mu, phi } = convertToGlicko2Scale(before.rating, before.ratingDeviation);
    // Retain the player's existing volatility; the Glicko-2 scale conversion
    // resets σ to the default, but the update must start from the current σ.
    const sigmaActual = before.volatility;

    // Step 3 — compute v (estimated variance from observed games).
    let vInvSum = 0;
    let deltaSum = 0;

    for (const match of matches) {
      const opp = convertToGlicko2Scale(match.opponentRating, match.opponentRatingDeviation);
      const gPhiJ = g(opp.phi);
      const eVal = E(mu, opp.mu, opp.phi);
      vInvSum += gPhiJ * gPhiJ * eVal * (1 - eVal);
      deltaSum += gPhiJ * (match.score - eVal);
    }

    const v = 1 / vInvSum;

    // Step 4 — compute Δ (improvement).
    const delta = v * deltaSum;

    // Step 5 — update volatility σ using the iterative algorithm.
    const newSigma = this.computeNewVolatility(sigmaActual, phi, v, delta);

    // Step 6 — update φ* then φ'.
    const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
    const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);

    // Step 7 — update µ'.
    const muNew = mu + phiNew * phiNew * deltaSum;

    // Convert back to Glicko-1 scale.
    const { rating, ratingDeviation } = convertFromGlicko2Scale(muNew, phiNew);

    const after: GlickoPlayer = {
      userId,
      rating: applyRatingFloor(Math.round(rating * 100) / 100),
      ratingDeviation: Math.round(ratingDeviation * 100) / 100,
      volatility: Math.round(newSigma * 1_000_000) / 1_000_000,
      interactionCount: before.interactionCount + matches.length,
      lastUpdatedAt: Date.now()
    };

    this.players.set(userId, after);
    return { userId, before, after: { ...after }, gamesProcessed: matches.length };
  }

  /**
   * Apply the Glicko-2 volatility update using the "Illinois" variant of the
   * regula-falsi method. This is the Glickman-recommended stable algorithm.
   */
  private computeNewVolatility(sigma: number, phi: number, v: number, delta: number): number {
    const a = Math.log(sigma * sigma);
    const tauSq = this.tau * this.tau;

    const f = (x: number): number => {
      const eX = Math.exp(x);
      const num = eX * (delta * delta - phi * phi - v - eX);
      const den = 2 * Math.pow(phi * phi + v + eX, 2);
      return num / den - (x - a) / tauSq;
    };

    let A = a;
    let B: number;
    if (delta * delta > phi * phi + v) {
      B = Math.log(delta * delta - phi * phi - v);
    } else {
      let k = 1;
      while (f(a - k * this.tau) < 0) {
        k += 1;
        if (k > 1000) break; // numeric safety
      }
      B = a - k * this.tau;
    }

    let fA = f(A);
    let fB = f(B);

    let iterations = 0;
    while (Math.abs(B - A) > GLICKO2_EPSILON && iterations < 1000) {
      const C = A + ((A - B) * fA) / (fB - fA);
      const fC = f(C);
      if (fC * fB <= 0) {
        A = B;
        fA = fB;
      } else {
        fA = fA / 2;
      }
      B = C;
      fB = fC;
      iterations += 1;
    }

    return Math.exp(A / 2);
  }

  /**
   * Batch processor capable of 1000+ updates/s without blocking the event loop.
   *
   * Updates are consumed in chunks of `MAX_SYNC_BATCH_SIZE`. Between chunks we
   * yield via `setImmediate` so HTTP/WebSocket handlers remain responsive.
   *
   * @param work A list of `{userId, matches}` pairs — one rating period per user.
   */
  async batchUpdate(
    work: ReadonlyArray<{ userId: string; matches: readonly GlickoMatch[] }>
  ): Promise<GlickoUpdateResult[]> {
    const results: GlickoUpdateResult[] = [];

    for (let i = 0; i < work.length; i += MAX_SYNC_BATCH_SIZE) {
      const slice = work.slice(i, i + MAX_SYNC_BATCH_SIZE);
      for (const item of slice) {
        results.push(this.update(item.userId, item.matches));
      }
      if (i + MAX_SYNC_BATCH_SIZE < work.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    return results;
  }

  /**
   * Convenience helper — compute a single game's result between two users,
   * equivalent to a rating period containing exactly one match per side.
   *
   * Useful for the swipe path which treats each "hold" as a symmetric win.
   */
  recordHeadToHead(
    userAId: string,
    userBId: string,
    scoreA: 0 | 0.5 | 1
  ): { a: GlickoUpdateResult; b: GlickoUpdateResult } {
    const a = this.getPlayer(userAId);
    const b = this.getPlayer(userBId);
    const scoreB = (1 - scoreA) as 0 | 0.5 | 1;

    const aResult = this.update(userAId, [
      { opponentRating: b.rating, opponentRatingDeviation: b.ratingDeviation, score: scoreA }
    ]);
    const bResult = this.update(userBId, [
      { opponentRating: a.rating, opponentRatingDeviation: a.ratingDeviation, score: scoreB }
    ]);

    return { a: aResult, b: bResult };
  }

  /**
   * Return the legacy Glicko-1 "expected score" between two users — used when
   * the lightweight swipe path needs a quick win probability.
   */
  expectedOutcome(userAId: string, userBId: string): number {
    const a = this.getPlayer(userAId);
    const b = this.getPlayer(userBId);
    return expectedScore(a.rating, b.rating);
  }
}
