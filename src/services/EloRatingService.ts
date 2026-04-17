/**
 * EloRatingService – dynamic K-factor ELO rating system for Quantchill matchmaking.
 *
 * Swipe outcomes feed directly into each user's ELO rating:
 *   - "skip"  → the skipped user suffers a loss (S = 0), the viewer gains a draw
 *               (S = 0.5) to prevent rating inflation.
 *   - "hold"  → the subject who held attention gains a win (S = 1); the viewer
 *               also gains a win (S = 1).
 *
 * K-factor scales down as a user accumulates more interactions (provisional → established).
 */

/** Outcome of a single swipe interaction. */
export type SwipeOutcome = 'skip' | 'hold';

/** Per-user ELO state persisted in the in-memory store. */
export interface EloRecord {
  userId: string;
  rating: number;
  interactionCount: number;
}

/** Result returned after processing a single swipe event. */
export interface SwipeResult {
  subjectId: string;
  viewerId: string;
  subjectNewRating: number;
  viewerNewRating: number;
  subjectDelta: number;
  viewerDelta: number;
}

/** Named ELO brackets used for peer discovery. */
export type EloBracket = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

const DEFAULT_ELO = 1000;

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

  /** Return the ELO record for a user, creating a default record if absent. */
  getRecord(userId: string): EloRecord {
    if (!this.store.has(userId)) {
      this.store.set(userId, { userId, rating: DEFAULT_ELO, interactionCount: 0 });
    }
    return this.store.get(userId)!;
  }

  /** Return the current numeric ELO rating for a user. */
  getRating(userId: string): number {
    return this.getRecord(userId).rating;
  }

  /** Return the ELO bracket for a user. */
  getBracket(userId: string): EloBracket {
    return getEloBracket(this.getRating(userId));
  }

  /**
   * Process a single swipe event and update both parties' ELO ratings.
   *
   * Outcome mapping:
   *   - 'skip' : subject loses (S_subject = 0), viewer draws (S_viewer = 0.5)
   *   - 'hold' : subject wins (S_subject = 1),  viewer wins  (S_viewer = 1)
   */
  processSwipe(viewerId: string, subjectId: string, outcome: SwipeOutcome): SwipeResult {
    const viewer = this.getRecord(viewerId);
    const subject = this.getRecord(subjectId);

    const vK = getDynamicKFactor(viewer.interactionCount);
    const sK = getDynamicKFactor(subject.interactionCount);

    const viewerActual = outcome === 'skip' ? 0.5 : 1;
    const subjectActual = outcome === 'skip' ? 0 : 1;

    const viewerExpected = expectedScore(viewer.rating, subject.rating);
    const subjectExpected = expectedScore(subject.rating, viewer.rating);

    const viewerNewRating = computeNewRating(viewer.rating, vK, viewerActual, viewerExpected);
    const subjectNewRating = computeNewRating(subject.rating, sK, subjectActual, subjectExpected);

    const viewerDelta = viewerNewRating - viewer.rating;
    const subjectDelta = subjectNewRating - subject.rating;

    viewer.rating = viewerNewRating;
    viewer.interactionCount += 1;
    subject.rating = subjectNewRating;
    subject.interactionCount += 1;

    return {
      subjectId,
      viewerId,
      subjectNewRating,
      viewerNewRating,
      subjectDelta,
      viewerDelta
    };
  }
}
