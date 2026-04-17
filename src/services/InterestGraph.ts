/**
 * InterestGraph — weighted, user-centric collaborative-filtering graph.
 *
 * Nodes:
 *   Users (identified by string userId).
 *
 * Edges:
 *   A → B with weight W represents the aggregate "signal" A has emitted about B
 *   (likes, superlikes, long dwells, etc.). Edges are directed so that asymmetric
 *   relationships (I like you, you skipped me) are representable.
 *
 * Updates are fed from `SwipeProcessor` via `applySignal`. The graph then
 * answers questions like:
 *   - `getEdge(a, b)`              → current weight.
 *   - `getNeighbors(a, k)`         → top-k peers A has signalled interest in.
 *   - `getRecommendations(a, k)`   → collaborative filter "users who liked the
 *                                   same set of targets as A also liked X".
 *   - `mutualMatches(a)`          → user pairs where both sides have a
 *                                   positive edge above the "mutual" threshold.
 *
 * The implementation is pure TypeScript, no third-party deps. It uses two
 * adjacency Maps for O(1) edge look-up in both directions, and a decay timer
 * so old signals lose influence over time (exponential half-life).
 */

import { CompatibilitySignal } from './SwipeProcessor';

export interface InterestEdge {
  source: string;
  target: string;
  weight: number;
  lastTouchedAt: number;
  interactionCount: number;
}

export interface RecommendationResult {
  userId: string;
  score: number;
  /** Sum of edge weights from similar users pointing at this candidate. */
  evidenceWeight: number;
  /** Number of similar users that signalled positively toward this candidate. */
  evidenceCount: number;
}

export interface InterestGraphConfig {
  /** Weight threshold at which an edge counts as "positive". */
  positiveThreshold: number;      // default 2
  /** Weight threshold at which two users are considered a "mutual match". */
  mutualThreshold: number;        // default 4
  /** Half-life for edge decay in milliseconds. */
  halfLifeMs: number;             // default 7 days
  /** Top-K peers considered when expanding for recommendations. */
  recommendationFanOut: number;   // default 25
}

export const DEFAULT_INTEREST_GRAPH_CONFIG: InterestGraphConfig = {
  positiveThreshold: 2,
  mutualThreshold: 4,
  halfLifeMs: 7 * 24 * 60 * 60 * 1000,
  recommendationFanOut: 25
};

/**
 * Pure helper — apply exponential decay to a weight given elapsed time.
 * Exported for unit testing.
 */
export function decayWeight(weight: number, elapsedMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0 || elapsedMs <= 0) return weight;
  const decayFactor = Math.pow(0.5, elapsedMs / halfLifeMs);
  const decayed = weight * decayFactor;
  // Snap tiny tails to 0 so the sparse map stays sparse.
  return Math.abs(decayed) < 1e-3 ? 0 : decayed;
}

export class InterestGraph {
  private readonly config: InterestGraphConfig;
  private readonly outgoing = new Map<string, Map<string, InterestEdge>>();
  private readonly incoming = new Map<string, Map<string, InterestEdge>>();
  private readonly now: () => number;

  constructor(overrides: Partial<InterestGraphConfig> = {}, nowFn: () => number = () => Date.now()) {
    this.config = { ...DEFAULT_INTEREST_GRAPH_CONFIG, ...overrides };
    this.now = nowFn;
  }

  /** Feed a swipe-derived compatibility signal into the graph. */
  applySignal(signal: CompatibilitySignal): InterestEdge {
    if (signal.userId === signal.targetId) {
      throw new Error('InterestGraph: self-edges are not allowed');
    }
    return this.addEdge(signal.userId, signal.targetId, signal.delta);
  }

  /** Explicitly add weight to an edge (used by tests / seeding). */
  addEdge(source: string, target: string, delta: number): InterestEdge {
    const t = this.now();
    const existing = this.getRawEdge(source, target);
    const decayedWeight = existing
      ? decayWeight(existing.weight, t - existing.lastTouchedAt, this.config.halfLifeMs)
      : 0;

    const edge: InterestEdge = {
      source,
      target,
      weight: decayedWeight + delta,
      lastTouchedAt: t,
      interactionCount: (existing?.interactionCount ?? 0) + 1
    };

    this.setRawEdge(edge);
    return edge;
  }

  /** Look up the (decayed) weight between two users. */
  getEdge(source: string, target: string): InterestEdge | null {
    const raw = this.getRawEdge(source, target);
    if (!raw) return null;
    const t = this.now();
    const weight = decayWeight(raw.weight, t - raw.lastTouchedAt, this.config.halfLifeMs);
    return { ...raw, weight };
  }

  /** Return the top-K users that `source` has signalled interest in, sorted desc. */
  getNeighbors(source: string, limit: number = 10): InterestEdge[] {
    const edges = this.outgoing.get(source);
    if (!edges) return [];
    const t = this.now();
    const decayed: InterestEdge[] = [];
    for (const edge of edges.values()) {
      const weight = decayWeight(edge.weight, t - edge.lastTouchedAt, this.config.halfLifeMs);
      if (weight > 0) decayed.push({ ...edge, weight });
    }
    decayed.sort((a, b) => b.weight - a.weight);
    return decayed.slice(0, limit);
  }

  /**
   * Collaborative-filtering recommendation.
   *
   * Algorithm:
   *   1. Find similar users — those who share the most targets with `userId`.
   *   2. For each similar user's top-N targets, accumulate an evidence score
   *      weighted by (similarity × edge.weight).
   *   3. Filter out any target the source has already rated.
   *   4. Return the top-K by evidence score.
   */
  getRecommendations(userId: string, count: number = 10): RecommendationResult[] {
    const self = this.getNeighbors(userId, this.config.recommendationFanOut);
    if (self.length === 0) return [];

    const selfTargets = new Set(self.map((e) => e.target));
    selfTargets.add(userId); // never recommend self

    const similar = this.findSimilarUsers(userId, selfTargets);

    const scores = new Map<string, RecommendationResult>();
    for (const { userId: peerId, similarity } of similar) {
      const peerEdges = this.getNeighbors(peerId, this.config.recommendationFanOut);
      for (const peerEdge of peerEdges) {
        if (selfTargets.has(peerEdge.target)) continue;
        if (peerEdge.weight < this.config.positiveThreshold) continue;

        const existing = scores.get(peerEdge.target) ?? {
          userId: peerEdge.target,
          score: 0,
          evidenceWeight: 0,
          evidenceCount: 0
        };
        existing.score += similarity * peerEdge.weight;
        existing.evidenceWeight += peerEdge.weight;
        existing.evidenceCount += 1;
        scores.set(peerEdge.target, existing);
      }
    }

    const ranked = Array.from(scores.values()).sort((a, b) => b.score - a.score);
    return ranked.slice(0, count);
  }

  /** Return the mutual-match partners of a user. */
  mutualMatches(userId: string): string[] {
    const outgoing = this.getNeighbors(userId, Number.POSITIVE_INFINITY);
    const mutual: string[] = [];
    for (const edge of outgoing) {
      if (edge.weight < this.config.mutualThreshold) continue;
      const back = this.getEdge(edge.target, userId);
      if (back && back.weight >= this.config.mutualThreshold) {
        mutual.push(edge.target);
      }
    }
    return mutual;
  }

  /** Total edges in the graph (for metrics/test). */
  edgeCount(): number {
    let total = 0;
    for (const map of this.outgoing.values()) total += map.size;
    return total;
  }

  /** Total unique users with at least one outgoing edge. */
  nodeCount(): number {
    const ids = new Set<string>();
    for (const source of this.outgoing.keys()) ids.add(source);
    for (const target of this.incoming.keys()) ids.add(target);
    return ids.size;
  }

  /** Serialise the graph for persistence. */
  snapshot(): InterestEdge[] {
    const out: InterestEdge[] = [];
    for (const map of this.outgoing.values()) {
      for (const edge of map.values()) out.push({ ...edge });
    }
    return out;
  }

  /** Rehydrate a graph from a snapshot. */
  restore(edges: readonly InterestEdge[]): void {
    this.outgoing.clear();
    this.incoming.clear();
    for (const edge of edges) this.setRawEdge({ ...edge });
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private findSimilarUsers(
    viewerId: string,
    viewerTargets: ReadonlySet<string>
  ): Array<{ userId: string; similarity: number }> {
    // For each target the viewer has rated, collect every *other* user who
    // has also rated it. Shared targets are the raw signal behind similarity.
    const candidateCounts = new Map<string, number>();
    for (const target of viewerTargets) {
      const raters = this.incoming.get(target);
      if (!raters) continue;
      for (const rater of raters.keys()) {
        if (rater === viewerId) continue;
        candidateCounts.set(rater, (candidateCounts.get(rater) ?? 0) + 1);
      }
    }

    const out: Array<{ userId: string; similarity: number }> = [];
    for (const [candidateId, sharedCount] of candidateCounts) {
      // Jaccard-like similarity bounded in [0,1].
      const candidateOut = this.outgoing.get(candidateId);
      const candidateTargets = candidateOut ? candidateOut.size : 0;
      const union = viewerTargets.size + candidateTargets - sharedCount;
      const similarity = union > 0 ? sharedCount / union : 0;
      if (similarity > 0) out.push({ userId: candidateId, similarity });
    }

    out.sort((a, b) => b.similarity - a.similarity);
    return out.slice(0, this.config.recommendationFanOut);
  }

  private getRawEdge(source: string, target: string): InterestEdge | undefined {
    return this.outgoing.get(source)?.get(target);
  }

  private setRawEdge(edge: InterestEdge): void {
    let srcMap = this.outgoing.get(edge.source);
    if (!srcMap) {
      srcMap = new Map();
      this.outgoing.set(edge.source, srcMap);
    }
    srcMap.set(edge.target, edge);

    let tgtMap = this.incoming.get(edge.target);
    if (!tgtMap) {
      tgtMap = new Map();
      this.incoming.set(edge.target, tgtMap);
    }
    tgtMap.set(edge.source, edge);
  }
}
