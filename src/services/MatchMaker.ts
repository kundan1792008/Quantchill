import { HiveMindAlgorithm, SentimentArray } from './HiveMindAlgorithm';
import { sameBracket } from './EloRatingService';

export interface InterestGraph {
  [interest: string]: number;
}

export interface UserProfile {
  id: string;
  interestGraph: InterestGraph;
  /** Current ELO rating; used for same-bracket peer discovery. Default: 1000. */
  eloRating?: number;
  /** Total rated interactions; determines dynamic K-factor. */
  interactionCount?: number;
  quantsinkFeed?: {
    feedId: string;
    isVip: boolean;
  };
  hologramMeshUrl?: string;
  hologramTextureUrl?: string;
  avatar3DData?: {
    scanDate: string;
    quality: 'low' | 'medium' | 'high' | 'ultra';
    format: 'gltf' | 'obj' | 'fbx';
  };
}

export interface BCIContext {
  eyeTrackingFocus: number;
  engagementScore: number;
  dopamineIndex?: number;
  attentionDecay?: number;
}

export interface MatchResult {
  candidate: UserProfile;
  score: number;
  shouldTransitionLoop: boolean;
}

export interface QuantsinkHook {
  mode: 'standard' | 'priority-feed';
  reason: 'interest-match' | 'attention-decay';
  attentionDecay: number | null;
  targetUserId?: string;
  targetFeedId?: string;
  usedCachedFeed: boolean;
}

export interface MatchResponse {
  candidates: MatchResult[];
  shouldTransitionLoop: boolean;
  quantsinkHook: QuantsinkHook;
}

export class MatchMaker {
  constructor(
    private readonly lowEngagementThreshold = 40,
    private readonly hiveMind?: HiveMindAlgorithm,
    private readonly attentionDecayThreshold = 0.3
  ) {}

  rankCandidates(user: UserProfile, candidates: UserProfile[], context: BCIContext): MatchResult[] {
    const prioritizeVip = this.shouldEscalateToPriorityFeed(context);
    const userElo = user.eloRating ?? 1000;
    // Calculate shouldTransitionLoop once instead of per-candidate
    const shouldTransition = this.shouldTransitionLoop(context);

    return candidates
      .filter((candidate) => candidate.id !== user.id)
      .map((candidate) => {
        const base = this.calculateCompatibility(user.interestGraph, candidate.interestGraph, context);
        // Grant a 10-point bonus when both users share the same ELO bracket so
        // that same-skill peers are preferred without overriding a strong
        // interest-graph match from a different bracket.
        const eloBonus = sameBracket(userElo, candidate.eloRating ?? 1000) ? 10 : 0;
        return {
          candidate,
          score: Number(Math.min(100, base + eloBonus).toFixed(2)),
          shouldTransitionLoop: shouldTransition
        };
      })
      .sort((a, b) => {
        if (prioritizeVip) {
          const aVip = a.candidate.quantsinkFeed?.isVip ? 1 : 0;
          const bVip = b.candidate.quantsinkFeed?.isVip ? 1 : 0;
          if (aVip !== bVip) return bVip - aVip;
        }
        return b.score - a.score;
      });
  }

  matchWithQuantsinkHook(user: UserProfile, candidates: UserProfile[], context: BCIContext): MatchResponse {
    const ranked = this.rankCandidates(user, candidates, context);
    const prioritizeVip = this.shouldEscalateToPriorityFeed(context);
    const priorityCandidate = prioritizeVip
      ? ranked.find((r) => r.candidate.quantsinkFeed?.isVip)
      : undefined;

    return {
      candidates: ranked,
      shouldTransitionLoop: this.shouldTransitionLoop(context),
      quantsinkHook: priorityCandidate
        ? {
            mode: 'priority-feed',
            reason: 'attention-decay',
            attentionDecay: context.attentionDecay ?? null,
            targetUserId: priorityCandidate.candidate.id,
            targetFeedId: priorityCandidate.candidate.quantsinkFeed?.feedId,
            usedCachedFeed: true
          }
        : {
            mode: 'standard',
            reason: 'interest-match',
            attentionDecay: context.attentionDecay ?? null,
            usedCachedFeed: false
          }
    };
  }

  shouldTransitionLoop(context: BCIContext): boolean {
    return context.engagementScore < this.lowEngagementThreshold || this.shouldEscalateToPriorityFeed(context);
  }

  shouldEscalateToPriorityFeed(context: BCIContext): boolean {
    return (context.attentionDecay ?? 1) < this.attentionDecayThreshold;
  }

  private calculateCompatibility(
    source: InterestGraph,
    target: InterestGraph,
    context: BCIContext
  ): number {
    const keys = new Set([...Object.keys(source), ...Object.keys(target)]);
    let overlapScore = 0;
    let totalWeight = 0;

    for (const key of keys) {
      const left = Math.max(0, source[key] ?? 0);
      const right = Math.max(0, target[key] ?? 0);

      if (this.hiveMind) {
        const weight = this.hiveMind.getWeight(key);
        overlapScore += Math.min(left, right) * weight;
        totalWeight += Math.max(left, right) * weight;
      } else {
        overlapScore += Math.min(left, right);
        totalWeight += Math.max(left, right);
      }
    }

    const graphSimilarity = totalWeight === 0 ? 0 : (overlapScore / totalWeight) * 100;
    const focusBoost = Math.min(1, Math.max(0, context.eyeTrackingFocus / 100)) * 15;

    let dopamineBoost: number;
    if (this.hiveMind) {
      const sentiment = this.bciContextToSentiment(context);
      dopamineBoost = this.hiveMind.computeSentimentBoost(sentiment);
    } else {
      dopamineBoost = Math.min(1, Math.max(0, (context.dopamineIndex ?? 50) / 100)) * 10;
    }

    return Number((graphSimilarity + focusBoost + dopamineBoost).toFixed(2));
  }

  private bciContextToSentiment(context: BCIContext): SentimentArray {
    const valence = (Math.min(100, Math.max(0, context.engagementScore)) / 100) * 2 - 1;
    const arousal = Math.min(1, Math.max(0, context.eyeTrackingFocus / 100));
    const dominance = Math.min(1, Math.max(0, (context.dopamineIndex ?? 50) / 100));
    return { valence, arousal, dominance };
  }
}
