import { BCIContext } from './MatchMaker';

/** The moods available in Quantchill's Mood Engine. */
export type MoodName = 'Deep Focus' | 'Cyberpunk Rain' | 'Ethereal Sleep' | 'Hype Workout';

export interface MoodConfig {
  name: MoodName;
  baseBpm: number;
  key: string;
  scale: string;
  /** Ambient visual theme identifier for the frontend / WebGL canvas. */
  visualTheme: string;
  baseIntensity: number;
}

export interface GeneratedTrackMetadata {
  mood: MoodName;
  bpm: number;
  key: string;
  scale: string;
  intensity: number;
  /** monotonically increasing counter per session; starts at 0. */
  variation: number;
}

export interface MoodTransitionEvent {
  previousMood: MoodName;
  nextMood: MoodName;
  reason: 'bci-low-engagement' | 'user-selected';
  engagementScore: number;
}

const MOOD_CATALOG: Record<MoodName, MoodConfig> = {
  'Deep Focus': {
    name: 'Deep Focus',
    baseBpm: 72,
    key: 'C',
    scale: 'major',
    visualTheme: 'deep-space',
    baseIntensity: 0.4
  },
  'Cyberpunk Rain': {
    name: 'Cyberpunk Rain',
    baseBpm: 90,
    key: 'D',
    scale: 'minor',
    visualTheme: 'neon-rain',
    baseIntensity: 0.65
  },
  'Ethereal Sleep': {
    name: 'Ethereal Sleep',
    baseBpm: 55,
    key: 'F',
    scale: 'major',
    visualTheme: 'aurora',
    baseIntensity: 0.2
  },
  'Hype Workout': {
    name: 'Hype Workout',
    baseBpm: 140,
    key: 'A',
    scale: 'minor',
    visualTheme: 'fire-pulse',
    baseIntensity: 0.95
  }
};

export class MoodEngine {
  private currentMood: MoodName;
  private variationCounter = 0;

  /** BCI engagement score below this threshold triggers an automatic transition. */
  private readonly engagementThreshold: number;

  constructor(initialMood: MoodName = 'Deep Focus', engagementThreshold = 40) {
    this.currentMood = initialMood;
    this.engagementThreshold = engagementThreshold;
  }

  /** Return all available mood configurations. */
  listMoods(): MoodConfig[] {
    return Object.values(MOOD_CATALOG);
  }

  /** Return the config for a specific mood by name. */
  getMoodConfig(mood: MoodName): MoodConfig {
    return MOOD_CATALOG[mood];
  }

  /** Return the currently active mood name. */
  getCurrentMood(): MoodName {
    return this.currentMood;
  }

  /**
   * Select a mood manually.
   * Resets the variation counter so the new stream starts fresh.
   */
  selectMood(mood: MoodName): MoodConfig {
    this.currentMood = mood;
    this.variationCounter = 0;
    return MOOD_CATALOG[mood];
  }

  /**
   * Generate metadata for the next AI-composed track.
   * Applies slight BPM/intensity drift per variation to simulate an
   * evolving infinite stream without repeating.
   */
  generateTrack(mood: MoodName = this.currentMood): GeneratedTrackMetadata {
    const base = MOOD_CATALOG[mood];
    const drift = this.variationCounter * 0.02;

    const bpm = Math.round(base.baseBpm * (1 + drift * 0.1));
    const intensity = Math.min(1, base.baseIntensity + drift);

    return {
      mood,
      bpm,
      key: base.key,
      scale: base.scale,
      intensity: Number(intensity.toFixed(2)),
      variation: this.variationCounter
    };
  }

  /**
   * Advance to the next variation of the current track (the "✨ Generate
   * Variation" button).  Returns the new track metadata.
   */
  evolveTrack(): GeneratedTrackMetadata {
    this.variationCounter += 1;
    return this.generateTrack();
  }

  /**
   * Evaluate a BCI context and, when engagement is low, automatically
   * transition to the most contrasting mood.  Returns a transition event if
   * a switch was made, or `null` if the current mood is retained.
   */
  evaluateBCIContext(context: BCIContext): MoodTransitionEvent | null {
    if (context.engagementScore >= this.engagementThreshold) {
      return null;
    }

    const previous = this.currentMood;
    const next = this.selectContrastMood(previous);
    this.selectMood(next);

    return {
      previousMood: previous,
      nextMood: next,
      reason: 'bci-low-engagement',
      engagementScore: context.engagementScore
    };
  }

  /**
   * Pick the most contrasting mood to keep the user engaged.
   * Cycles through the catalog picking the highest BPM delta.
   */
  private selectContrastMood(current: MoodName): MoodName {
    const currentBpm = MOOD_CATALOG[current].baseBpm;
    let bestMood: MoodName = current;
    let bestDelta = -Infinity;

    for (const [name, config] of Object.entries(MOOD_CATALOG) as [MoodName, MoodConfig][]) {
      if (name === current) continue;
      const delta = Math.abs(config.baseBpm - currentBpm);
      if (delta > bestDelta) {
        bestDelta = delta;
        bestMood = name;
      }
    }

    return bestMood;
  }
}
