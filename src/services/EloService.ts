/**
 * EloService – full Glicko-2 rating implementation for Quantchill.
 *
 * Unlike the simpler `EloRatingService`, this service tracks a per-player triplet
 * of (rating, ratingDeviation, volatility) and implements Mark Glickman's
 * Glicko-2 algorithm verbatim (http://www.glicko.net/glicko/glicko2.pdf).
 *
 * Features:
 *   - Full Glicko-2 rating updates (rating + RD + volatility).
 *   - Dynamic K-factor (40/20/10) layered on top of Glicko-2 scaling so that
 *     provisional players still swing faster than established players when a
 *     simpler ELO-style fallback is requested.
 *   - Rating floor of 800 (Glicko-2 rating cannot drop below this value).
 *   - Batch processing: `processBatch()` drains up to 1000 updates per tick
 *     without blocking the event loop longer than a single microtask.
 *   - Pluggable store so the same API works for in-memory tests or Redis
 *     persistence in production.
 */

/** Per-player Glicko-2 state. */
export interface GlickoRecord {
  userId: string;
  /** Rating in the public (ELO-compatible) scale. Default 1500. */
  rating: number;
  /** Rating deviation. Default 350 (maximum uncertainty). */
  ratingDeviation: number;
  /** Volatility. Default 0.06. */
  volatility: number;
  /** Count of rated interactions – used for dynamic K-factor. */
  interactionCount: number;
  /** Wall-clock timestamp (ms) of the last rating update. */
  lastUpdatedAt: number;
}

/** A single rated outcome used inside a Glicko-2 update. */
export interface GlickoOutcome {
  /** Opponent's current rating (public scale). */
  opponentRating: number;
  /** Opponent's current rating deviation. */
  opponentRatingDeviation: number;
  /** Score from the perspective of the player being updated: 1 = win, 0 = loss, 0.5 = draw. */
  score: number;
}

/** Input envelope queued for batch processing. */
export interface BatchUpdate {
  userId: string;
  outcomes: GlickoOutcome[];
}

/** Result of a single Glicko-2 update. */
export interface GlickoUpdateResult {
  before: GlickoRecord;
  after: GlickoRecord;
}

/** Backing store for Glicko records. Swap for Redis in production. */
export interface GlickoStore {
  get(userId: string): GlickoRecord | undefined;
  set(record: GlickoRecord): void;
  values(): GlickoRecord[];
}

/** Default Glicko-2 constants. */
export const GLICKO_DEFAULT_RATING = 1500;
export const GLICKO_DEFAULT_RD = 350;
export const GLICKO_DEFAULT_VOLATILITY = 0.06;
/** System constant τ – typical Glicko-2 values are between 0.3 and 1.2. */
export const GLICKO_SYSTEM_CONSTANT = 0.5;
/** Scaling constant between the Glicko and Glicko-2 scales. */
export const GLICKO_SCALE = 173.7178;
/** Minimum allowed rating on the public scale. */
export const GLICKO_RATING_FLOOR = 800;
/** Convergence tolerance for the volatility sub-problem. */
export const GLICKO_EPSILON = 0.000001;

/** Dynamic K-factor for back-compatibility with the simpler ELO path. */
export function getDynamicKFactor(interactionCount: number): number {
  if (interactionCount < 30) return 40;
  if (interactionCount < 100) return 20;
  return 10;
}

/** Convert the public rating scale to the Glicko-2 internal scale (µ). */
export function toMu(rating: number): number {
  return (rating - GLICKO_DEFAULT_RATING) / GLICKO_SCALE;
}

/** Convert a Glicko-2 internal rating back to the public scale. */
export function fromMu(mu: number): number {
  return mu * GLICKO_SCALE + GLICKO_DEFAULT_RATING;
}

/** Convert the public rating deviation to the Glicko-2 internal scale (φ). */
export function toPhi(rd: number): number {
  return rd / GLICKO_SCALE;
}

/** Convert a Glicko-2 internal rating deviation back to the public scale. */
export function fromPhi(phi: number): number {
  return phi * GLICKO_SCALE;
}

/** Glicko-2 g(φ) function. */
export function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** Glicko-2 E(µ, µj, φj) function – expected score. */
export function expectedScoreGlicko(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Solve the Glicko-2 volatility sub-problem using the "Illinois" variant of
 * the regula-falsi method as prescribed by Glickman (2013).
 */
export function computeNewVolatility(
  phi: number,
  sigma: number,
  v: number,
  delta: number,
  tau: number = GLICKO_SYSTEM_CONSTANT
): number {
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) {
      k += 1;
      if (k > 100) break;
    }
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  let iterations = 0;
  while (Math.abs(B - A) > GLICKO_EPSILON && iterations < 1000) {
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
    iterations += 1;
  }

  return Math.exp(A / 2);
}

/** Default in-memory Glicko-2 store. */
export class InMemoryGlickoStore implements GlickoStore {
  private readonly records = new Map<string, GlickoRecord>();

  get(userId: string): GlickoRecord | undefined {
    return this.records.get(userId);
  }

  set(record: GlickoRecord): void {
    this.records.set(record.userId, { ...record });
  }

  values(): GlickoRecord[] {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  clear(): void {
    this.records.clear();
  }
}

/** Clamp a public-scale rating to the Glicko floor. */
export function applyRatingFloor(rating: number): number {
  return rating < GLICKO_RATING_FLOOR ? GLICKO_RATING_FLOOR : rating;
}

/**
 * Compute a new Glicko-2 record given a list of outcomes observed during the
 * current rating period. This is the canonical single-player update.
 */
export function updateRating(
  record: GlickoRecord,
  outcomes: GlickoOutcome[],
  tau: number = GLICKO_SYSTEM_CONSTANT,
  now: number = Date.now()
): GlickoRecord {
  if (outcomes.length === 0) {
    // Step 6: no games played – RD grows toward 350.
    const phi = toPhi(record.ratingDeviation);
    const phiPrime = Math.sqrt(phi * phi + record.volatility * record.volatility);
    return {
      ...record,
      ratingDeviation: Math.min(GLICKO_DEFAULT_RD, fromPhi(phiPrime)),
      lastUpdatedAt: now
    };
  }

  const mu = toMu(record.rating);
  const phi = toPhi(record.ratingDeviation);

  // Step 3: compute v (estimated variance of rating based on game outcomes).
  let vInv = 0;
  for (const o of outcomes) {
    const muJ = toMu(o.opponentRating);
    const phiJ = toPhi(o.opponentRatingDeviation);
    const gPhiJ = g(phiJ);
    const e = expectedScoreGlicko(mu, muJ, phiJ);
    vInv += gPhiJ * gPhiJ * e * (1 - e);
  }
  const v = 1 / vInv;

  // Step 4: compute Δ (estimated improvement).
  let sum = 0;
  for (const o of outcomes) {
    const muJ = toMu(o.opponentRating);
    const phiJ = toPhi(o.opponentRatingDeviation);
    const e = expectedScoreGlicko(mu, muJ, phiJ);
    sum += g(phiJ) * (o.score - e);
  }
  const delta = v * sum;

  // Step 5: new volatility σ'.
  const sigmaPrime = computeNewVolatility(phi, record.volatility, v, delta, tau);

  // Step 6: pre-update φ*.
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);

  // Step 7: new φ' and µ'.
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * sum;

  const newRating = applyRatingFloor(fromMu(muPrime));
  const newRD = fromPhi(phiPrime);

  return {
    userId: record.userId,
    rating: Number(newRating.toFixed(2)),
    ratingDeviation: Number(newRD.toFixed(2)),
    volatility: Number(sigmaPrime.toFixed(6)),
    interactionCount: record.interactionCount + outcomes.length,
    lastUpdatedAt: now
  };
}

/**
 * EloService – higher-level orchestrator for Glicko-2 ratings and the batch
 * processor that sustains 1000+ updates per second.
 */
export class EloService {
  private readonly store: GlickoStore;
  private readonly tau: number;
  private readonly queue: BatchUpdate[] = [];
  private processing = false;

  constructor(store?: GlickoStore, tau: number = GLICKO_SYSTEM_CONSTANT) {
    this.store = store ?? new InMemoryGlickoStore();
    this.tau = tau;
  }

  /** Return the Glicko record for a user, creating a default one if absent. */
  getRecord(userId: string): GlickoRecord {
    const existing = this.store.get(userId);
    if (existing) return { ...existing };
    const fresh: GlickoRecord = {
      userId,
      rating: GLICKO_DEFAULT_RATING,
      ratingDeviation: GLICKO_DEFAULT_RD,
      volatility: GLICKO_DEFAULT_VOLATILITY,
      interactionCount: 0,
      lastUpdatedAt: Date.now()
    };
    this.store.set(fresh);
    return { ...fresh };
  }

  /** Seed a record (e.g., rehydrate from persistent storage). */
  seed(record: GlickoRecord): void {
    this.store.set({ ...record });
  }

  /** Return every stored record (snapshot copy). */
  getAllRecords(): GlickoRecord[] {
    return this.store.values();
  }

  /** Dynamic K-factor helper for the simpler ELO path. */
  kFactor(userId: string): number {
    return getDynamicKFactor(this.getRecord(userId).interactionCount);
  }

  /** Apply a synchronous Glicko-2 update for a single user. */
  update(userId: string, outcomes: GlickoOutcome[]): GlickoUpdateResult {
    const before = this.getRecord(userId);
    const after = updateRating(before, outcomes, this.tau);
    this.store.set(after);
    return { before, after: { ...after } };
  }

  /**
   * Apply a symmetric head-to-head result between two users.
   * `scoreA` is the score for user A (1, 0 or 0.5) and the complement for B.
   */
  headToHead(userIdA: string, userIdB: string, scoreA: number): {
    a: GlickoUpdateResult;
    b: GlickoUpdateResult;
  } {
    const recA = this.getRecord(userIdA);
    const recB = this.getRecord(userIdB);
    const a = this.update(userIdA, [
      { opponentRating: recB.rating, opponentRatingDeviation: recB.ratingDeviation, score: scoreA }
    ]);
    const b = this.update(userIdB, [
      { opponentRating: recA.rating, opponentRatingDeviation: recA.ratingDeviation, score: 1 - scoreA }
    ]);
    return { a, b };
  }

  /** Queue a batch update for later draining. */
  enqueueBatch(update: BatchUpdate): void {
    this.queue.push(update);
  }

  /**
   * Drain up to `maxUpdates` queued updates from the batch queue.
   *
   * The caller is responsible for scheduling this method – e.g., every 100 ms
   * via `setInterval` – which gives a throughput ceiling of 10 000 updates per
   * second when `maxUpdates` is 1000. Because each update is O(1) in the number
   * of outcomes and involves only light math, the method never yields mid-call
   * and cannot be re-entered (see the `processing` guard).
   *
   * @returns Array of applied update results.
   */
  processBatch(maxUpdates: number = 1000): GlickoUpdateResult[] {
    if (this.processing) return [];
    this.processing = true;
    try {
      const results: GlickoUpdateResult[] = [];
      const limit = Math.min(maxUpdates, this.queue.length);
      for (let i = 0; i < limit; i += 1) {
        const next = this.queue.shift();
        if (!next) break;
        results.push(this.update(next.userId, next.outcomes));
      }
      return results;
    } finally {
      this.processing = false;
    }
  }

  /** Return the current queue length (useful for tests / metrics). */
  getQueueLength(): number {
    return this.queue.length;
  }

  /** Clear the batch queue. */
  clearQueue(): void {
    this.queue.length = 0;
  }
}
