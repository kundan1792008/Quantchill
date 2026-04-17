/**
 * EloService – Glicko-2 rating system for Quantchill matchmaking.
 *
 * Implements the full Glicko-2 algorithm as described by Mark Glickman
 * (http://www.glicko.net/glicko/glicko2.pdf).
 *
 * Key differences from basic ELO:
 *  - Tracks `rating`, `ratingDeviation` (RD), and `volatility` per user.
 *  - RD shrinks as a user plays more games (confidence in rating increases).
 *  - RD grows during inactivity (confidence decreases over time).
 *  - Volatility σ reflects the degree of expected rating fluctuation.
 *  - Rating floor: 800 (no user can fall below this value).
 *
 * Glicko-2 internal scale uses μ = (r − 1500) / 173.7178, φ = RD / 173.7178.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Conversion factor between Glicko-1 and Glicko-2 scales. */
const SCALE = 173.7178;

/** Default starting rating on the Glicko-1 scale. */
const DEFAULT_RATING = 1000;

/** Default rating deviation – 350 for a brand-new player. */
const DEFAULT_RD = 350;

/** Default volatility – controls expected rating fluctuation. */
const DEFAULT_VOLATILITY = 0.06;

/** System constant τ – constrains how quickly volatility can change. */
const TAU = 0.5;

/** Rating floor – no user's rating can fall below this value. */
const RATING_FLOOR = 800;

/** Maximum iterations for the Illinois algorithm (volatility computation). */
const MAX_ITER = 100;

/** Convergence tolerance for the Illinois algorithm. */
const CONVERGENCE_TOL = 1e-6;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-user Glicko-2 state stored in the in-memory (or Redis-backed) store. */
export interface Glicko2Record {
  userId: string;
  /** Glicko-1 scale rating (displayed to users). Default: 1000. */
  rating: number;
  /** Rating deviation on the Glicko-1 scale. Default: 350. */
  ratingDeviation: number;
  /** Volatility – expected rating fluctuation. Default: 0.06. */
  volatility: number;
  /** Total rated interactions (determines legacy K-factor for display). */
  interactionCount: number;
}

/** A single game result used in batch processing. */
export interface GameResult {
  opponentId: string;
  /** Outcome score: 1 = win, 0 = loss, 0.5 = draw. */
  score: number;
}

/** Result returned after a batch rating update. */
export interface RatingUpdateResult {
  userId: string;
  oldRating: number;
  newRating: number;
  newRatingDeviation: number;
  newVolatility: number;
}

/** Named ELO brackets derived from the Glicko-2 rating. */
export type Glicko2Bracket = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

// ─── Pure Glicko-2 functions ──────────────────────────────────────────────────

/**
 * g(φ) – the volatility-adjusted game-impact function.
 * Reduces the impact of a game result when the opponent's RD is large.
 */
export function gPhi(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/**
 * E(μ, μⱼ, φⱼ) – expected score for a player with rating μ against an
 * opponent with rating μⱼ and deviation φⱼ.
 */
export function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-gPhi(phiJ) * (mu - muJ)));
}

/**
 * Convert a Glicko-1 rating and RD to the Glicko-2 internal scale.
 */
export function toGlicko2Scale(rating: number, rd: number): { mu: number; phi: number } {
  return {
    mu: (rating - 1500) / SCALE,
    phi: rd / SCALE
  };
}

/**
 * Convert Glicko-2 internal scale values back to the Glicko-1 display scale.
 */
export function fromGlicko2Scale(mu: number, phi: number): { rating: number; rd: number } {
  return {
    rating: SCALE * mu + 1500,
    rd: SCALE * phi
  };
}

/**
 * Compute the estimated variance v of the player's rating based on a set
 * of game results against opponents with known ratings and deviations.
 *
 * @param mu          Player's rating on the Glicko-2 scale.
 * @param opponents   Array of { mu: opponentMu, phi: opponentPhi } objects.
 */
export function computeVariance(mu: number, opponents: Array<{ mu: number; phi: number }>): number {
  let sum = 0;
  for (const opp of opponents) {
    const g = gPhi(opp.phi);
    const e = expectedScore(mu, opp.mu, opp.phi);
    sum += g * g * e * (1 - e);
  }
  return sum === 0 ? Infinity : 1 / sum;
}

/**
 * Compute the rating improvement Δ (delta) for a player based on a set of
 * game results.
 *
 * @param mu          Player's rating on the Glicko-2 scale.
 * @param v           Estimated variance (from computeVariance).
 * @param opponents   Array of { mu, phi } for each opponent.
 * @param scores      Array of actual scores (same order as opponents).
 */
export function computeDelta(
  mu: number,
  v: number,
  opponents: Array<{ mu: number; phi: number }>,
  scores: number[]
): number {
  let sum = 0;
  for (let i = 0; i < opponents.length; i++) {
    const opp = opponents[i]!;
    const g = gPhi(opp.phi);
    const e = expectedScore(mu, opp.mu, opp.phi);
    sum += g * (scores[i]! - e);
  }
  return v * sum;
}

/**
 * Compute the new volatility σ' using the Illinois algorithm (an iterative
 * root-finding method).
 *
 * @param phi     Current RD on Glicko-2 scale.
 * @param sigma   Current volatility.
 * @param delta   Rating improvement estimate.
 * @param v       Estimated variance.
 */
export function computeNewVolatility(phi: number, sigma: number, delta: number, v: number): number {
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const delta2 = delta * delta;

  function f(x: number): number {
    const ex = Math.exp(x);
    const phi2_ex = phi2 + v + ex;
    return (
      (ex * (delta2 - phi2_ex)) / (2 * phi2_ex * phi2_ex) -
      (x - a) / (TAU * TAU)
    );
  }

  let A = a;
  let B: number;

  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) {
      k++;
    }
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);

  for (let i = 0; i < MAX_ITER; i++) {
    if (Math.abs(B - A) <= CONVERGENCE_TOL) break;
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);

    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

/**
 * Compute the pre-period rating deviation φ* which accounts for the
 * increase in uncertainty since the last rating period.
 */
export function computePrePeriodPhi(phi: number, newSigma: number): number {
  return Math.sqrt(phi * phi + newSigma * newSigma);
}

/**
 * Map a Glicko-1 rating to a named bracket.
 *
 * Brackets (Quantchill scale):
 *   diamond  ≥ 1600
 *   platinum ≥ 1400
 *   gold     ≥ 1200
 *   silver   ≥ 1000
 *   bronze    < 1000
 */
export function getGlicko2Bracket(rating: number): Glicko2Bracket {
  if (rating >= 1600) return 'diamond';
  if (rating >= 1400) return 'platinum';
  if (rating >= 1200) return 'gold';
  if (rating >= 1000) return 'silver';
  return 'bronze';
}

/**
 * Returns the legacy dynamic K-factor based on interaction count.
 * Used for display purposes / compatibility with the existing swipe system.
 *
 *   provisional  (< 30 interactions) : K = 40
 *   intermediate (< 100 interactions): K = 20
 *   established  (≥ 100 interactions): K = 10
 */
export function getDynamicKFactor(interactionCount: number): number {
  if (interactionCount < 30) return 40;
  if (interactionCount < 100) return 20;
  return 10;
}

// ─── EloService class ─────────────────────────────────────────────────────────

/**
 * EloService – Glicko-2 rating system with batch processing support.
 *
 * Exposes both:
 *  1. `processGameResults(userId, results)` – full Glicko-2 batch update.
 *  2. `processSwipe(viewerId, subjectId, outcome)` – convenience single-game
 *     wrapper compatible with the existing SwipeOutcome type.
 *
 * The in-memory store can be replaced with a Redis hash for horizontal scaling.
 * All public methods keep identical signatures.
 */
export class EloService {
  private readonly store = new Map<string, Glicko2Record>();

  /** Return the Glicko-2 record for a user, initialising defaults if absent. */
  getRecord(userId: string): Glicko2Record {
    if (!this.store.has(userId)) {
      this.store.set(userId, {
        userId,
        rating: DEFAULT_RATING,
        ratingDeviation: DEFAULT_RD,
        volatility: DEFAULT_VOLATILITY,
        interactionCount: 0
      });
    }
    return this.store.get(userId)!;
  }

  /** Return the display rating for a user. */
  getRating(userId: string): number {
    return this.getRecord(userId).rating;
  }

  /** Return the Glicko-2 bracket label for a user. */
  getBracket(userId: string): Glicko2Bracket {
    return getGlicko2Bracket(this.getRating(userId));
  }

  /**
   * Seed a record (e.g. loaded from a persistent store on startup).
   */
  seedRecord(record: Glicko2Record): void {
    this.store.set(record.userId, { ...record });
  }

  /** Return a snapshot of all stored records. */
  getAllRecords(): Glicko2Record[] {
    return Array.from(this.store.values()).map((r) => ({ ...r }));
  }

  /**
   * Process a batch of game results for a single user using the full Glicko-2
   * algorithm.  Supports up to 1 000 updates per second (pure in-memory, no
   * I/O) without blocking.
   *
   * If the user has no games in the current rating period their RD increases
   * slightly (uncertainty grows during inactivity) but their rating is
   * unchanged.
   *
   * @param userId   The user whose rating is being updated.
   * @param results  Array of game results from the current rating period.
   */
  processGameResults(userId: string, results: GameResult[]): RatingUpdateResult {
    const record = this.getRecord(userId);
    const oldRating = record.rating;

    // Convert to Glicko-2 internal scale.
    const { mu, phi } = toGlicko2Scale(record.rating, record.ratingDeviation);
    const sigma = record.volatility;

    // No games played – only update RD (uncertainty grows).
    if (results.length === 0) {
      const newPhi = Math.sqrt(phi * phi + sigma * sigma);
      const { rating, rd } = fromGlicko2Scale(mu, newPhi);
      record.rating = Math.max(RATING_FLOOR, Math.round(rating));
      record.ratingDeviation = rd;
      return {
        userId,
        oldRating,
        newRating: record.rating,
        newRatingDeviation: record.ratingDeviation,
        newVolatility: sigma
      };
    }

    // Build opponent list in Glicko-2 scale.
    const opponents = results.map((r) => {
      const opp = this.getRecord(r.opponentId);
      return toGlicko2Scale(opp.rating, opp.ratingDeviation);
    });
    const scores = results.map((r) => r.score);

    const v = computeVariance(mu, opponents);
    const delta = computeDelta(mu, v, opponents, scores);
    const newSigma = computeNewVolatility(phi, sigma, delta, v);
    const phiStar = computePrePeriodPhi(phi, newSigma);

    // New phi (RD on Glicko-2 scale).
    const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);

    // New mu (rating on Glicko-2 scale).
    let improvement = 0;
    for (let i = 0; i < opponents.length; i++) {
      const opp = opponents[i]!;
      const g = gPhi(opp.phi);
      const e = expectedScore(mu, opp.mu, opp.phi);
      improvement += g * (scores[i]! - e);
    }
    const newMu = mu + newPhi * newPhi * improvement;

    // Convert back to Glicko-1 display scale and apply rating floor.
    const { rating: newRating, rd: newRd } = fromGlicko2Scale(newMu, newPhi);
    record.rating = Math.max(RATING_FLOOR, Math.round(newRating));
    record.ratingDeviation = Math.max(30, newRd); // RD floor at 30
    record.volatility = newSigma;
    record.interactionCount += results.length;

    return {
      userId,
      oldRating,
      newRating: record.rating,
      newRatingDeviation: record.ratingDeviation,
      newVolatility: newSigma
    };
  }

  /**
   * Convenience single-swipe update.  Wraps `processGameResults` so it can be
   * used as a drop-in replacement for `EloRatingService.processSwipe`.
   *
   *  - 'like' / 'superlike' → viewer wins (score = 1), subject wins (score = 1)
   *  - 'skip' → subject loses (score = 0), viewer draws (score = 0.5)
   */
  processSwipe(
    viewerId: string,
    subjectId: string,
    action: 'like' | 'skip' | 'superlike'
  ): { viewerResult: RatingUpdateResult; subjectResult: RatingUpdateResult } {
    const viewerScore = action === 'skip' ? 0.5 : 1;
    const subjectScore = action === 'skip' ? 0 : 1;

    const viewerResult = this.processGameResults(viewerId, [
      { opponentId: subjectId, score: viewerScore }
    ]);
    const subjectResult = this.processGameResults(subjectId, [
      { opponentId: viewerId, score: subjectScore }
    ]);

    return { viewerResult, subjectResult };
  }
}
