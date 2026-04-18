/**
 * EloRatingService – dynamic K-factor ELO rating system for Quantchill matchmaking.
 *
 * Swipe outcomes feed directly into each user's ELO rating:
 *   - "skip"  → the skipped user suffers a loss (S = 0), the skipper gains a marginal win (S = 1).
 *   - "hold"  → the user who held attention gains a win; the viewer gains a marginal win too.
 *
 * K-factor scales down as a user accumulates more interactions (provisional → established).
 */

/** Outcome of a single swipe interaction. */
export type SwipeOutcome = 'skip' | 'hold';

/** Per-user ELO state persisted in the in-memory store. */
export interface EloRecord {
  userId: string;
  /** Current ELO rating; default starting value is 1000. */
  rating: number;
  /** Total number of rated interactions used to compute dynamic K-factor. */
  interactionCount: number;
  /**
   * Exponentially-smoothed rating used whenever a rating is shown to the
   * user. Smoothing reduces visible swing from single interactions so that
   * users are not nudged toward obsessive rating-watching behaviour. This
   * field is always populated – defaults to `rating` on first interaction.
   */
  smoothedRating: number;
}

/**
 * A single point in a user's rating history. History is only ever returned
 * to the user whose rating it is, via an explicit pull request; it is never
 * pushed and never exposed to third parties.
 */
export interface RatingHistoryPoint {
  /** Unix ms timestamp at which the rating was recorded. */
  timestamp: number;
  /** Raw ELO rating immediately after the interaction. */
  rating: number;
  /** EMA-smoothed rating at the same point. */
  smoothedRating: number;
}

/** Result returned after processing a single swipe event. */
export interface SwipeResult {
  viewerId: string;
  subjectId: string;
  outcome: SwipeOutcome;
  /** Updated ELO record for the subject (whose rating changed most). */
  subjectElo: EloRecord;
  /** Updated ELO record for the viewer. */
  viewerElo: EloRecord;
}

/** Named ELO brackets used for peer discovery. */
export type EloBracket = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

const DEFAULT_ELO = 1000;

/**
 * Smoothing factor (alpha) for the EMA applied to displayed ratings.
 *
 * smoothed_n = alpha * raw_n + (1 - alpha) * smoothed_(n-1)
 *
 * A low alpha (0.2) means ~80% of the displayed rating is the previous
 * smoothed value; a single interaction therefore moves the displayed number
 * modestly. This is deliberate: we do not want users to feel a visible
 * "rating drop" after one skip, which is a known anxiety driver in rated
 * matching products.
 *
 * Rationale for 0.2: with K ≤ 40, the maximum raw per-swipe delta is ~40
 * points; alpha=0.2 caps the per-swipe displayed delta at ~8 points – large
 * enough to trend over a few interactions, small enough that no single swipe
 * produces a visible jolt. Revisit if K-factor constants change materially.
 */
export const RATING_SMOOTHING_ALPHA = 0.2;

/** Maximum number of rating-history points retained per user (rolling). */
export const RATING_HISTORY_LIMIT = 500;

/**
 * Compute the next EMA-smoothed rating.
 *
 * @param rawRating        Latest raw (post-swipe) ELO rating.
 * @param previousSmoothed Previously displayed smoothed rating.
 * @param alpha            Smoothing factor in (0, 1]; higher = more reactive.
 */
export function emaSmooth(
  rawRating: number,
  previousSmoothed: number,
  alpha: number = RATING_SMOOTHING_ALPHA
): number {
  if (!(alpha > 0 && alpha <= 1)) {
    throw new Error('alpha must be in (0, 1]');
  }
  return Math.round(alpha * rawRating + (1 - alpha) * previousSmoothed);
}

/**
 * Returns the K-factor for a player based on their interaction count.
 *
 * Matches FIDE-style tiered K to create a fast-settling curve for new users:
 *   - Provisional  (< 30 interactions) : K = 40
 *   - Intermediate (< 100 interactions): K = 20
 *   - Established  (≥ 100 interactions): K = 10
 */
export function getDynamicKFactor(interactionCount: number): number {
  if (interactionCount < 30) return 40;
  if (interactionCount < 100) return 20;
  return 10;
}

/**
 * Compute the expected score for player A given both ratings.
 *
 * Uses the standard ELO logistic formula with a 400-point scale divisor.
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Compute the new rating for a player after a single game.
 *
 * @param currentRating  Player's current ELO rating.
 * @param kFactor        Dynamic K-factor for this player.
 * @param actual         Actual outcome score (1 = win, 0 = loss, 0.5 = draw).
 * @param expected       Expected outcome score from `expectedScore()`.
 * @returns              New rating, rounded to nearest integer.
 */
export function computeNewRating(
  currentRating: number,
  kFactor: number,
  actual: number,
  expected: number
): number {
  return Math.round(currentRating + kFactor * (actual - expected));
}

/**
 * Map a numeric ELO rating to a named bracket.
 *
 * Brackets (Quantchill scale):
 *   diamond  ≥ 1600
 *   platinum ≥ 1400
 *   gold     ≥ 1200
 *   silver   ≥ 1000
 *   bronze    < 1000
 */
export function getEloBracket(rating: number): EloBracket {
  if (rating >= 1600) return 'diamond';
  if (rating >= 1400) return 'platinum';
  if (rating >= 1200) return 'gold';
  if (rating >= 1000) return 'silver';
  return 'bronze';
}

/**
 * Returns true if two ratings fall within the same ELO bracket.
 * Used by MatchMaker to prefer same-bracket peer discovery.
 */
export function sameBracket(ratingA: number, ratingB: number): boolean {
  return getEloBracket(ratingA) === getEloBracket(ratingB);
}

/**
 * In-memory ELO store with O(1) read/write access.
 *
 * In production this store can be replaced with a Redis hash for horizontal
 * scaling (100 k+ swipe events per second); the public interface is identical.
 */
export class EloRatingService {
  private readonly store = new Map<string, EloRecord>();
  private readonly history = new Map<string, RatingHistoryPoint[]>();
  private readonly settings?: { isRatingVisible(userId: string): boolean };

  /**
   * @param settings Optional wellbeing-settings provider used to decide whether
   *                 a user's rating may be surfaced. When omitted, rating is
   *                 treated as hidden (conservative default) – callers must
   *                 explicitly wire in a settings service to enable display.
   */
  constructor(settings?: { isRatingVisible(userId: string): boolean }) {
    this.settings = settings;
  }

  /** Return the ELO record for a user, creating a default record if absent. */
  getRecord(userId: string): EloRecord {
    if (!this.store.has(userId)) {
      this.store.set(userId, {
        userId,
        rating: DEFAULT_ELO,
        interactionCount: 0,
        smoothedRating: DEFAULT_ELO
      });
    }
    const record = this.store.get(userId)!;
    // Back-compat: records seeded before EMA was added may be missing the
    // smoothed field. Populate it lazily without mutating raw rating.
    if (typeof record.smoothedRating !== 'number') {
      record.smoothedRating = record.rating;
    }
    return record;
  }

  /** Return the current numeric ELO rating for a user. */
  getRating(userId: string): number {
    return this.getRecord(userId).rating;
  }

  /**
   * Return the smoothed rating that should be shown in user-facing UI.
   * Honours `UserWellbeingSettings.hideEloRating` (default: hidden); returns
   * `null` if the user has not opted in to seeing their rating.
   *
   * Note: this method is the ONLY sanctioned way to surface a rating to the
   * owning user. Never return `record.rating` directly from an API.
   */
  getDisplayRating(userId: string): number | null {
    if (!this.settings || !this.settings.isRatingVisible(userId)) {
      return null;
    }
    return this.getRecord(userId).smoothedRating;
  }

  /** Return the ELO bracket for a user. */
  getBracket(userId: string): EloBracket {
    return getEloBracket(this.getRating(userId));
  }

  /**
   * Process a single swipe event and update both parties' ELO ratings.
   *
   * Outcome mapping:
   *   - 'skip' : subject loses (S_subject = 0), viewer wins (S_viewer = 1)
   *   - 'hold' : subject wins (S_subject = 1), viewer wins (S_viewer = 1)
   *
   * Both parties' interaction counts are incremented by 1 per swipe event.
   *
   * @param viewerId   User who performed the swipe.
   * @param subjectId  User who was swiped on (shown on screen).
   * @param outcome    'skip' or 'hold'.
   * @returns          Updated ELO records for both parties.
   */
  processSwipe(viewerId: string, subjectId: string, outcome: SwipeOutcome): SwipeResult {
    const viewer = this.getRecord(viewerId);
    const subject = this.getRecord(subjectId);

    const eViewer = expectedScore(viewer.rating, subject.rating);
    const eSubject = expectedScore(subject.rating, viewer.rating);

    const kViewer = getDynamicKFactor(viewer.interactionCount);
    const kSubject = getDynamicKFactor(subject.interactionCount);

    // 'hold': both parties win (S=1) – mutual engagement is rewarded.
    // 'skip': the subject loses (S=0); the viewer draws (S=0.5) – no credit
    //         for skipping, preventing systematic upward rating drift.
    const sViewer = outcome === 'hold' ? 1 : 0.5;
    const sSubject = outcome === 'hold' ? 1 : 0;

    viewer.rating = computeNewRating(viewer.rating, kViewer, sViewer, eViewer);
    subject.rating = computeNewRating(subject.rating, kSubject, sSubject, eSubject);

    viewer.smoothedRating = emaSmooth(viewer.rating, viewer.smoothedRating);
    subject.smoothedRating = emaSmooth(subject.rating, subject.smoothedRating);

    viewer.interactionCount += 1;
    subject.interactionCount += 1;

    const now = Date.now();
    this.appendHistory(viewer.userId, {
      timestamp: now,
      rating: viewer.rating,
      smoothedRating: viewer.smoothedRating
    });
    this.appendHistory(subject.userId, {
      timestamp: now,
      rating: subject.rating,
      smoothedRating: subject.smoothedRating
    });

    return {
      viewerId,
      subjectId,
      outcome,
      subjectElo: { ...subject },
      viewerElo: { ...viewer }
    };
  }

  /**
   * Append a rating-history point for a user, keeping only the most recent
   * `RATING_HISTORY_LIMIT` entries to bound memory.
   */
  private appendHistory(userId: string, point: RatingHistoryPoint): void {
    const arr = this.history.get(userId) ?? [];
    arr.push(point);
    if (arr.length > RATING_HISTORY_LIMIT) {
      arr.splice(0, arr.length - RATING_HISTORY_LIMIT);
    }
    this.history.set(userId, arr);
  }

  /**
   * Return a user's rating history.
   *
   * Access policy: this is a pull-only endpoint callers are responsible for
   * authenticating. A user may only retrieve their OWN history. The service
   * layer honours `UserWellbeingSettings.hideEloRating`: if the user has not
   * opted in to seeing their rating, we return `null` rather than leaking a
   * side-channel view of the data.
   *
   * @param userId     The user requesting their own history.
   * @param sinceMs    Optional lower bound (Unix ms); inclusive.
   */
  getRatingHistory(userId: string, sinceMs?: number): RatingHistoryPoint[] | null {
    if (this.settings && !this.settings.isRatingVisible(userId)) {
      return null;
    }
    const arr = this.history.get(userId) ?? [];
    if (sinceMs === undefined) return arr.map((p) => ({ ...p }));
    return arr.filter((p) => p.timestamp >= sinceMs).map((p) => ({ ...p }));
  }

  /**
   * Return all stored ELO records (snapshot copy).
   * Useful for bulk reads when seeding a Redis mirror on startup.
   */
  getAllRecords(): EloRecord[] {
    return Array.from(this.store.values()).map((r) => ({ ...r }));
  }

  /** Seed an ELO record (e.g., loaded from a persistent store). */
  seedRecord(record: EloRecord): void {
    this.store.set(record.userId, {
      ...record,
      smoothedRating:
        typeof record.smoothedRating === 'number' ? record.smoothedRating : record.rating
    });
  }
}
