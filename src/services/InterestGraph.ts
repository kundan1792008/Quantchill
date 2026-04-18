/**
 * InterestGraph – weighted user-interest graph with collaborative filtering.
 *
 * Nodes  : users
 * Edges  : mutual interest score (symmetric, non-negative)
 *
 * Edge weights are derived from swipe patterns:
 *   like       → +2
 *   superlike  → +5
 *   skip       → -1 (weight is clamped at 0, edges cannot go negative; users
 *                    who have only skipped each other simply carry weight 0 and
 *                    are pruned from the adjacency list)
 *
 * `getRecommendations(userId, count)` implements collaborative filtering in
 * the classic "users who liked X also liked Y" style. For every candidate Y we
 * sum the edge weight from the querying user U to every neighbour X multiplied
 * by X's edge weight to Y:
 *
 *     score(U, Y) = Σ_x  w(U, X) × w(X, Y)
 *
 * Candidates Y that U already has a direct edge to are excluded, as are the
 * user themself. The result is sorted by descending score and truncated to the
 * requested count.
 */

export type SwipeAction = 'like' | 'skip' | 'superlike';

/** Edge weight contribution per action. */
export const ACTION_WEIGHTS: Record<SwipeAction, number> = {
  like: 2,
  superlike: 5,
  skip: -1
};

/** A recommendation returned from `getRecommendations`. */
export interface Recommendation {
  userId: string;
  score: number;
  /** Number of intermediate neighbours that contributed to the score. */
  supportingPaths: number;
}

/** Options for `InterestGraph`. */
export interface InterestGraphOptions {
  /** Minimum absolute weight to keep an edge. Defaults to 0 (drop non-positive). */
  minWeight?: number;
  /** Per-action weight overrides. */
  actionWeights?: Partial<Record<SwipeAction, number>>;
}

/** Internal edge map type. */
type EdgeMap = Map<string, Map<string, number>>;

/** Weighted, symmetric graph of user interests. */
export class InterestGraph {
  private readonly edges: EdgeMap = new Map();
  private readonly minWeight: number;
  private readonly actionWeights: Record<SwipeAction, number>;

  constructor(options: InterestGraphOptions = {}) {
    this.minWeight = options.minWeight ?? 0;
    this.actionWeights = { ...ACTION_WEIGHTS, ...options.actionWeights };
  }

  /** Record a swipe action, updating the U↔V edge symmetrically. */
  recordAction(userId: string, targetId: string, action: SwipeAction): void {
    if (userId === targetId) return;
    const delta = this.actionWeights[action];
    this.adjustEdge(userId, targetId, delta);
  }

  /** Directly adjust the edge weight between two users (symmetric). */
  adjustEdge(a: string, b: string, delta: number): number {
    if (a === b) return 0;
    const current = this.getEdge(a, b);
    const next = Math.max(0, current + delta);
    if (next <= this.minWeight) {
      this.removeEdge(a, b);
      return 0;
    }
    this.getOrCreateNeighbours(a).set(b, next);
    this.getOrCreateNeighbours(b).set(a, next);
    return next;
  }

  /** Remove an edge between two users. */
  removeEdge(a: string, b: string): boolean {
    const removedA = this.edges.get(a)?.delete(b) ?? false;
    const removedB = this.edges.get(b)?.delete(a) ?? false;
    return removedA || removedB;
  }

  /** Return the edge weight between two users (0 when absent). */
  getEdge(a: string, b: string): number {
    return this.edges.get(a)?.get(b) ?? 0;
  }

  /** Return every neighbour of the user, keyed by user id. */
  neighbours(userId: string): Map<string, number> {
    const n = this.edges.get(userId);
    return n ? new Map(n) : new Map();
  }

  /** Return every known node in the graph. */
  nodes(): string[] {
    return Array.from(this.edges.keys());
  }

  /** Return total edge count (undirected). */
  edgeCount(): number {
    let total = 0;
    const seen = new Set<string>();
    for (const [a, neighbours] of this.edges) {
      for (const b of neighbours.keys()) {
        const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!seen.has(pair)) {
          seen.add(pair);
          total += 1;
        }
      }
    }
    return total;
  }

  /**
   * Collaborative filtering: "users who liked X also liked Y".
   *
   * Walks two hops outward from `userId`, accumulating weighted scores for
   * every two-step destination. Direct neighbours and the user themself are
   * filtered out.
   */
  getRecommendations(userId: string, count: number): Recommendation[] {
    if (count <= 0) return [];
    const firstHop = this.edges.get(userId);
    if (!firstHop || firstHop.size === 0) return [];

    const scores = new Map<string, { score: number; support: number }>();
    for (const [intermediateId, weightToIntermediate] of firstHop) {
      const intermediateNeighbours = this.edges.get(intermediateId);
      if (!intermediateNeighbours) continue;
      for (const [candidateId, weightToCandidate] of intermediateNeighbours) {
        if (candidateId === userId) continue;
        if (firstHop.has(candidateId)) continue;
        const contribution = weightToIntermediate * weightToCandidate;
        if (contribution <= 0) continue;
        const existing = scores.get(candidateId);
        if (existing) {
          existing.score += contribution;
          existing.support += 1;
        } else {
          scores.set(candidateId, { score: contribution, support: 1 });
        }
      }
    }

    return Array.from(scores.entries())
      .map(([id, v]) => ({
        userId: id,
        score: Number(v.score.toFixed(4)),
        supportingPaths: v.support
      }))
      .sort((a, b) => b.score - a.score || b.supportingPaths - a.supportingPaths)
      .slice(0, count);
  }

  /** Return top N direct neighbours by weight. */
  topNeighbours(userId: string, count: number): Recommendation[] {
    const list = this.edges.get(userId);
    if (!list) return [];
    return Array.from(list.entries())
      .map(([id, score]) => ({ userId: id, score, supportingPaths: 1 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count);
  }

  /** Clear the entire graph – used for tests. */
  clear(): void {
    this.edges.clear();
  }

  private getOrCreateNeighbours(userId: string): Map<string, number> {
    let n = this.edges.get(userId);
    if (!n) {
      n = new Map();
      this.edges.set(userId, n);
    }
    return n;
  }
}
