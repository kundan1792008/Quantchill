/**
 * InterestGraph – weighted user-interest graph with collaborative filtering.
 *
 * Builds a bipartite graph where:
 *  - User nodes accumulate edge weights toward interests they engage with.
 *  - Interest weights are derived from swipe actions:
 *      superlike → weight += 3
 *      like      → weight += 1
 *      skip      → weight -= 0.5  (soft negative signal)
 *
 * Collaborative filtering:
 *  "Users who liked X also liked Y" – computes cosine similarity between user
 *  interest vectors to surface candidates the requesting user hasn't seen yet.
 *
 * Exposes:
 *  - `recordSwipe(userId, targetId, interests, action)` – update graph.
 *  - `getInterests(userId)` – return the weighted interest vector for a user.
 *  - `getSimilarity(userA, userB)` – cosine similarity in [0, 1].
 *  - `getRecommendations(userId, count)` – top-N candidates sorted by
 *    descending cosine similarity, excluding users already swiped.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const WEIGHT_SUPERLIKE = 3;
const WEIGHT_LIKE = 1;
const WEIGHT_SKIP = -0.5;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Weighted map of interest tags → affinity score for one user. */
export type InterestVector = Record<string, number>;

/** A single recommendation returned by `getRecommendations`. */
export interface Recommendation {
  userId: string;
  similarity: number;
  sharedInterests: string[];
}

// ─── InterestGraph ────────────────────────────────────────────────────────────

export class InterestGraph {
  /** userId → weighted interest vector. */
  private readonly userVectors = new Map<string, InterestVector>();

  /** userId → Set of targetIds the user has already swiped on. */
  private readonly swipeHistory = new Map<string, Set<string>>();

  // ── Graph mutations ──────────────────────────────────────────────────────

  /**
   * Record a swipe action and update the swiping user's interest vector.
   *
   * @param userId    The user who swiped.
   * @param targetId  The user who was swiped on.
   * @param interests Interest tags associated with the target's profile.
   * @param action    The swipe action performed.
   */
  recordSwipe(
    userId: string,
    targetId: string,
    interests: string[],
    action: 'like' | 'skip' | 'superlike'
  ): void {
    const delta =
      action === 'superlike' ? WEIGHT_SUPERLIKE :
      action === 'like'      ? WEIGHT_LIKE      :
                               WEIGHT_SKIP;

    const vector = this.getOrCreateVector(userId);
    for (const interest of interests) {
      vector[interest] = (vector[interest] ?? 0) + delta;
    }

    // Record swipe history to exclude already-seen targets from recommendations.
    const history = this.swipeHistory.get(userId) ?? new Set<string>();
    history.add(targetId);
    this.swipeHistory.set(userId, history);
  }

  // ── Read accessors ───────────────────────────────────────────────────────

  /** Return a copy of the interest vector for a user. */
  getInterests(userId: string): InterestVector {
    return { ...(this.userVectors.get(userId) ?? {}) };
  }

  /**
   * Compute the cosine similarity between two users' interest vectors.
   * Returns a value in [0, 1] where 1 = identical interest profiles.
   */
  getSimilarity(userA: string, userB: string): number {
    const vecA = this.userVectors.get(userA) ?? {};
    const vecB = this.userVectors.get(userB) ?? {};
    return cosineSimilarity(vecA, vecB);
  }

  /**
   * Return the top-N candidate recommendations for a user based on
   * collaborative filtering (cosine similarity on interest vectors).
   *
   * Excludes:
   *  - The requesting user themselves.
   *  - Users the requesting user has already swiped on.
   *
   * @param userId  The user requesting recommendations.
   * @param count   Maximum number of recommendations to return.
   */
  getRecommendations(userId: string, count: number): Recommendation[] {
    const seen = this.swipeHistory.get(userId) ?? new Set<string>();
    const results: Recommendation[] = [];

    for (const [candidateId] of this.userVectors) {
      if (candidateId === userId) continue;
      if (seen.has(candidateId)) continue;

      const similarity = this.getSimilarity(userId, candidateId);
      const shared = this.sharedInterests(userId, candidateId);
      results.push({ userId: candidateId, similarity, sharedInterests: shared });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, count);
  }

  /** Return all user IDs currently tracked in the graph. */
  getAllUserIds(): string[] {
    return Array.from(this.userVectors.keys());
  }

  /**
   * Seed a user's interest vector directly (e.g., from profile data on
   * registration).
   */
  seedInterests(userId: string, vector: InterestVector): void {
    const existing = this.getOrCreateVector(userId);
    for (const [interest, weight] of Object.entries(vector)) {
      existing[interest] = (existing[interest] ?? 0) + weight;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getOrCreateVector(userId: string): InterestVector {
    if (!this.userVectors.has(userId)) {
      this.userVectors.set(userId, {});
    }
    return this.userVectors.get(userId)!;
  }

  /** Return interests present in both users' vectors with positive weights. */
  private sharedInterests(userA: string, userB: string): string[] {
    const vecA = this.userVectors.get(userA) ?? {};
    const vecB = this.userVectors.get(userB) ?? {};
    return Object.keys(vecA).filter(
      (k) => (vecA[k] ?? 0) > 0 && (vecB[k] ?? 0) > 0
    );
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two sparse interest vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(vecA: InterestVector, vecB: InterestVector): number {
  const keysA = Object.keys(vecA);
  if (keysA.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (const k of keysA) {
    const a = vecA[k] ?? 0;
    const b = vecB[k] ?? 0;
    dot += a * b;
    magA += a * a;
  }

  for (const v of Object.values(vecB)) {
    magB += v * v;
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
