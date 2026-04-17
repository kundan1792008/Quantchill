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

    viewer.interactionCount += 1;
    subject.interactionCount += 1;

    return {
      viewerId,
      subjectId,
      outcome,
      subjectElo: { ...subject },
      viewerElo: { ...viewer }
    };
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
    this.store.set(record.userId, { ...record });
  }
}
