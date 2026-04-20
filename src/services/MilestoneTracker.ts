export interface ConversationSnapshot {
  conversationId: string;
  participants: [string, string];
  startedAtMs: number;
  nowMs: number;
  messageCount: number;
  averageWordsPerMessage: number;
  compatibilityScore: number;
}

export type MilestoneTier = 'starter' | 'connected' | 'resonant' | 'deep-link';

export interface MilestoneProgress {
  tier: MilestoneTier;
  progressPct: number;
  rewardLabel: string;
  nextTier: MilestoneTier | null;
  nextTierRemainingMessages: number;
  nextTierRemainingMinutes: number;
}

export interface MilestoneState {
  conversationId: string;
  participants: [string, string];
  achievedTiers: MilestoneTier[];
  activeTier: MilestoneTier;
  progress: MilestoneProgress;
  updatedAtMs: number;
}

interface TierConfig {
  name: MilestoneTier;
  minCompatibility: number;
  minMinutes: number;
  minMessages: number;
  rewardLabel: string;
}

const TIERS: readonly TierConfig[] = [
  {
    name: 'starter',
    minCompatibility: 0,
    minMinutes: 2,
    minMessages: 6,
    rewardLabel: 'Conversation Spark'
  },
  {
    name: 'connected',
    minCompatibility: 50,
    minMinutes: 8,
    minMessages: 18,
    rewardLabel: 'Connection Pulse'
  },
  {
    name: 'resonant',
    minCompatibility: 70,
    minMinutes: 16,
    minMessages: 35,
    rewardLabel: 'Resonance Flow'
  },
  {
    name: 'deep-link',
    minCompatibility: 82,
    minMinutes: 28,
    minMessages: 58,
    rewardLabel: 'Deep Link'
  }
] as const;

const PROGRESS_WEIGHTS = {
  messages: 0.35,
  minutes: 0.35,
  compatibility: 0.3
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class MilestoneTracker {
  private readonly states = new Map<string, MilestoneState>();

  update(snapshot: ConversationSnapshot): MilestoneState {
    const elapsedMinutes = Math.max(0, (snapshot.nowMs - snapshot.startedAtMs) / 60_000);
    const score = clamp(snapshot.compatibilityScore, 0, 100);

    const achievedTiers = TIERS.filter(
      (tier) =>
        score >= tier.minCompatibility &&
        elapsedMinutes >= tier.minMinutes &&
        snapshot.messageCount >= tier.minMessages
    ).map((tier) => tier.name);

    const activeTier = achievedTiers[achievedTiers.length - 1] ?? 'starter';
    const progress = this.buildProgress(activeTier, snapshot, elapsedMinutes, score);

    const state: MilestoneState = {
      conversationId: snapshot.conversationId,
      participants: snapshot.participants,
      achievedTiers,
      activeTier,
      progress,
      updatedAtMs: snapshot.nowMs
    };

    this.states.set(snapshot.conversationId, state);
    return state;
  }

  get(conversationId: string): MilestoneState | null {
    const state = this.states.get(conversationId);
    return state ? { ...state, achievedTiers: [...state.achievedTiers], progress: { ...state.progress } } : null;
  }

  private buildProgress(
    activeTier: MilestoneTier,
    snapshot: ConversationSnapshot,
    elapsedMinutes: number,
    compatibilityScore: number
  ): MilestoneProgress {
    const currentTier = TIERS.find((tier) => tier.name === activeTier) ?? TIERS[0]!;
    const currentIndex = TIERS.findIndex((tier) => tier.name === currentTier.name);
    const nextTier = currentIndex >= TIERS.length - 1 ? null : TIERS[currentIndex + 1]!;

    if (!nextTier) {
      return {
        tier: activeTier,
        progressPct: 100,
        rewardLabel: currentTier.rewardLabel,
        nextTier: null,
        nextTierRemainingMessages: 0,
        nextTierRemainingMinutes: 0
      };
    }

    const messageProgress = snapshot.messageCount / nextTier.minMessages;
    const minuteProgress = elapsedMinutes / nextTier.minMinutes;
    const compatibilityProgress = compatibilityScore / nextTier.minCompatibility;
    const progressPct = clamp(
      ((messageProgress * PROGRESS_WEIGHTS.messages +
        minuteProgress * PROGRESS_WEIGHTS.minutes +
        compatibilityProgress * PROGRESS_WEIGHTS.compatibility) * 100),
      0,
      99.9
    );

    return {
      tier: activeTier,
      progressPct: Number(progressPct.toFixed(2)),
      rewardLabel: currentTier.rewardLabel,
      nextTier: nextTier.name,
      nextTierRemainingMessages: Math.max(0, nextTier.minMessages - snapshot.messageCount),
      nextTierRemainingMinutes: Number(Math.max(0, nextTier.minMinutes - elapsedMinutes).toFixed(2))
    };
  }
}
