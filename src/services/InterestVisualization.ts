/**
 * InterestVisualization – animated overlay descriptor for the video dating
 * profile highlight reel.
 *
 * Produces a self-contained `InterestOverlayPlan` that a renderer can use to
 * draw animated text/icon layers on top of the `VideoProfile` clips.
 *
 * Features:
 *   1. Wordcloud burst  – interests pop in one by one with spring animations.
 *   2. Activity heatmap – "Most active on {days}" banner with day-of-week bars.
 *   3. Location tag     – animated pin drop with pulse ring.
 *   4. Icon badges      – per-interest emoji/icon pulled from a curated map.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of interests shown in the wordcloud burst. */
export const MAX_WORDCLOUD_INTERESTS = 8;

/** Stagger delay between successive interest-word animations (seconds). */
export const WORDCLOUD_STAGGER_S = 0.18;

/** Duration of each individual word's pop-in animation (seconds). */
export const WORDCLOUD_POP_DURATION_S = 0.35;

/** Scale overshoot for the spring pop-in (framer-motion / reanimated style). */
export const WORDCLOUD_SPRING_OVERSHOOT = 1.2;

/** Number of horizontal bars shown in the activity heatmap. */
export const HEATMAP_DAYS = 7; // Mon–Sun

/** Pin-drop animation duration (seconds). */
export const LOCATION_PIN_DROP_DURATION_S = 0.6;

/** Number of pulse-ring ripples emitted from the pin. */
export const LOCATION_PULSE_RINGS = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

export type DayOfWeek =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday'
  | 'Sunday';

/** Normalised activity level for one day of the week ([0, 1]). */
export interface DayActivity {
  day: DayOfWeek;
  /** Normalised activity intensity [0, 1]. */
  level: number;
  /** Whether this day is in the "peak" set for the banner copy. */
  isPeak: boolean;
}

/** Single entry in the interest wordcloud. */
export interface WordcloudWord {
  /** The interest tag (e.g. "hiking", "jazz", "coffee"). */
  text: string;
  /** Affinity weight [0, 100] used to scale font size. */
  weight: number;
  /** Resolved emoji icon for this interest. */
  icon: string;
  /**
   * Font size in pixels.  Computed as `baseFontSizePx * (weight / 100)`.
   * Clamped to [MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX].
   */
  fontSizePx: number;
  /** Hex colour assigned from the palette rotation. */
  color: string;
  /** Delay in seconds before this word's animation begins. */
  animationDelayS: number;
}

/** Full wordcloud burst descriptor. */
export interface WordcloudBurst {
  /** Ordered list of words (highest weight first). */
  words: WordcloudWord[];
  /** Time at which the burst should start within the reel (seconds). */
  startAtS: number;
  /** Total duration from first word appearing to last word fully visible (seconds). */
  totalDurationS: number;
}

/** Activity heatmap overlay. */
export interface ActivityHeatmap {
  /** Per-day activity bars. */
  days: DayActivity[];
  /** Text banner derived from peak days (e.g. "Most active on weekends"). */
  bannerText: string;
  /** Time at which the heatmap should appear (seconds). */
  startAtS: number;
  /** Fade-in duration (seconds). */
  fadeInDurationS: number;
}

/** Location tag overlay with animated pin drop. */
export interface LocationTag {
  /** Display string (e.g. "San Francisco, CA" or "New York"). */
  label: string;
  /**
   * Normalised position within the frame: (0, 0) = top-left.
   * Default: (0.5, 0.85) — centred near the bottom.
   */
  position: { x: number; y: number };
  /** Time at which the pin should drop (seconds). */
  startAtS: number;
  /** Pin drop animation duration (seconds). */
  dropDurationS: number;
  /** Number of ripple rings emitted after the pin lands. */
  pulseRings: number;
  /** Delay between successive rings (seconds). */
  pulseIntervalS: number;
}

/** Complete overlay plan attached to a video profile reel. */
export interface InterestOverlayPlan {
  /** User whose interests are visualised. */
  userId: string;
  /** Wordcloud burst descriptor. */
  wordcloud: WordcloudBurst;
  /** Activity heatmap descriptor. */
  heatmap: ActivityHeatmap;
  /** Location tag descriptor (null if no location is available). */
  locationTag: LocationTag | null;
  /** ISO 8601 timestamp of plan generation. */
  generatedAt: string;
}

// ─── Input types ──────────────────────────────────────────────────────────────

/** Input data required to build an overlay plan. */
export interface InterestVisualizationInput {
  userId: string;
  /**
   * Weighted interest vector (interest tag → affinity [0, 100]).
   * At least one entry is required.
   */
  interests: Record<string, number>;
  /**
   * Per-hour-of-day activity levels (index 0–23 → activity count).
   * Used to derive day-of-week heatmap data.
   */
  hourlyActivity?: number[];
  /**
   * Per-day-of-week activity overrides (Mon=0 … Sun=6 → count).
   * When provided, takes precedence over `hourlyActivity` aggregation.
   */
  dailyActivity?: number[];
  /** Optional display location string. */
  location?: string;
  /**
   * Time offset (seconds) within the 15-second reel at which overlays start.
   * Defaults to 0.
   */
  overlayStartAtS?: number;
}

// ─── Constants: font sizes, colours, icon map ─────────────────────────────────

const BASE_FONT_SIZE_PX = 28;
const MIN_FONT_SIZE_PX = 14;
const MAX_FONT_SIZE_PX = 48;

const WORDCLOUD_PALETTE: readonly string[] = [
  '#a78bfa', // violet
  '#38bdf8', // sky
  '#34d399', // emerald
  '#fb923c', // orange
  '#f472b6', // pink
  '#facc15', // yellow
  '#60a5fa', // blue
  '#4ade80', // green
];

/** Curated emoji icons keyed by common interest tag substrings. */
const INTEREST_ICON_MAP: ReadonlyArray<{ keywords: string[]; icon: string }> = [
  { keywords: ['music', 'jazz', 'guitar', 'piano', 'sing', 'band', 'concert'], icon: '🎵' },
  { keywords: ['travel', 'adventure', 'explore', 'trip', 'backpack'], icon: '✈️' },
  { keywords: ['coffee', 'café', 'espresso', 'brew', 'latte'], icon: '☕' },
  { keywords: ['food', 'cook', 'chef', 'bake', 'recipe', 'eat'], icon: '🍳' },
  { keywords: ['fitness', 'gym', 'workout', 'run', 'yoga', 'sport', 'hike', 'hiking'], icon: '💪' },
  { keywords: ['art', 'draw', 'paint', 'sketch', 'design', 'creative'], icon: '🎨' },
  { keywords: ['tech', 'code', 'coding', 'program', 'software', 'dev'], icon: '💻' },
  { keywords: ['film', 'movie', 'cinema', 'watch', 'series', 'tv'], icon: '🎬' },
  { keywords: ['book', 'read', 'lit', 'novel', 'poetry', 'write'], icon: '📚' },
  { keywords: ['game', 'gaming', 'esport', 'console', 'pc', 'rpg'], icon: '🎮' },
  { keywords: ['dog', 'cat', 'pet', 'animal'], icon: '🐾' },
  { keywords: ['photo', 'camera', 'lens', 'shoot'], icon: '📷' },
  { keywords: ['surf', 'swim', 'beach', 'ocean', 'sea', 'water'], icon: '🌊' },
  { keywords: ['mountain', 'climb', 'ski', 'snow', 'outdoor'], icon: '⛰️' },
  { keywords: ['dance', 'ballet', 'salsa', 'tango'], icon: '💃' },
  { keywords: ['fashion', 'style', 'cloth', 'wear', 'trend'], icon: '👗' },
  { keywords: ['wine', 'beer', 'cocktail', 'drink', 'bar'], icon: '🍷' },
  { keywords: ['yoga', 'meditat', 'mindful', 'zen', 'wellness'], icon: '🧘' },
  { keywords: ['astro', 'star', 'space', 'cosmos', 'galaxy'], icon: '🌌' },
  { keywords: ['sport', 'football', 'soccer', 'basketball', 'tennis'], icon: '⚽' },
];

const DEFAULT_INTEREST_ICON = '✨';

/** Days of the week in order. */
const DAYS_OF_WEEK: DayOfWeek[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

// ─── Internal helpers ─────────────────────────────────────────────────────────

function resolveIcon(tag: string): string {
  const lower = tag.toLowerCase();
  for (const entry of INTEREST_ICON_MAP) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return entry.icon;
    }
  }
  return DEFAULT_INTEREST_ICON;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function fontSizeForWeight(weight: number): number {
  return clamp(
    Math.round(BASE_FONT_SIZE_PX * (weight / 100)),
    MIN_FONT_SIZE_PX,
    MAX_FONT_SIZE_PX,
  );
}

/**
 * Aggregate hourly activity data into per-day totals.
 * Hour 0–23 are mapped onto days by dividing into 3-hour bands and assigning
 * to Mon (morning) … Sun (night) cyclically — this is a simplistic heuristic
 * used only when the caller does not provide explicit daily data.
 */
function aggregateHourlyToDays(hourly: number[]): number[] {
  const days = new Array<number>(7).fill(0);
  for (let h = 0; h < Math.min(hourly.length, 24); h++) {
    const dayIdx = Math.floor((h / 24) * 7);
    days[dayIdx] = (days[dayIdx] ?? 0) + (hourly[h] ?? 0);
  }
  return days;
}

/** Normalise an array so its maximum is 1.0. */
function normaliseMax(values: number[]): number[] {
  const max = Math.max(...values, 1);
  return values.map((v) => v / max);
}

/** Build the human-readable banner for the activity heatmap. */
function buildActivityBanner(days: DayActivity[]): string {
  const peakDays = days.filter((d) => d.isPeak).map((d) => d.day);

  if (peakDays.length === 0) return 'Active every day';

  const weekendDays: DayOfWeek[] = ['Saturday', 'Sunday'];
  const weekdayDays: DayOfWeek[] = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
  ];

  const allWeekend = weekendDays.every((d) => peakDays.includes(d));
  const allWeekdays = weekdayDays.every((d) => peakDays.includes(d));

  if (allWeekend && peakDays.length === 2) return 'Most active on weekends';
  if (allWeekdays && peakDays.length === 5) return 'Most active on weekdays';

  if (peakDays.length === 1) return `Most active on ${peakDays[0]}s`;
  if (peakDays.length === 2)
    return `Most active on ${peakDays[0]} & ${peakDays[1]}`;
  return `Most active on ${peakDays.slice(0, -1).join(', ')} & ${peakDays[peakDays.length - 1]}`;
}

// ─── InterestVisualization ────────────────────────────────────────────────────

/**
 * Stateless service — call `buildOverlayPlan()` with a user's interest data
 * to receive a complete `InterestOverlayPlan`.
 */
export class InterestVisualization {
  // ── Wordcloud ──────────────────────────────────────────────────────────────

  /**
   * Build a `WordcloudBurst` from a weighted interest vector.
   *
   * Words are ordered by weight descending and receive staggered animation
   * delays so they pop in one-by-one.
   */
  buildWordcloud(
    interests: Record<string, number>,
    startAtS: number,
  ): WordcloudBurst {
    // Sort interests by weight descending.
    const sorted = Object.entries(interests)
      .filter(([, w]) => w > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_WORDCLOUD_INTERESTS);

    const words: WordcloudWord[] = sorted.map(([text, weight], idx) => ({
      text,
      weight,
      icon: resolveIcon(text),
      fontSizePx: fontSizeForWeight(weight),
      color: WORDCLOUD_PALETTE[idx % WORDCLOUD_PALETTE.length]!,
      animationDelayS: idx * WORDCLOUD_STAGGER_S,
    }));

    const totalDurationS =
      words.length > 0
        ? (words.length - 1) * WORDCLOUD_STAGGER_S + WORDCLOUD_POP_DURATION_S
        : 0;

    return { words, startAtS, totalDurationS };
  }

  // ── Activity heatmap ───────────────────────────────────────────────────────

  /**
   * Build an `ActivityHeatmap` from per-day activity counts.
   *
   * Days whose normalised level exceeds 0.65 are marked as peak days.
   */
  buildHeatmap(
    dailyActivityRaw: number[],
    startAtS: number,
  ): ActivityHeatmap {
    const paddedRaw = [
      ...dailyActivityRaw,
      ...new Array(Math.max(0, HEATMAP_DAYS - dailyActivityRaw.length)).fill(0),
    ].slice(0, HEATMAP_DAYS);

    const normalised = normaliseMax(paddedRaw);

    const days: DayActivity[] = DAYS_OF_WEEK.map((day, i) => ({
      day,
      level: normalised[i] ?? 0,
      isPeak: (normalised[i] ?? 0) >= 0.65,
    }));

    return {
      days,
      bannerText: buildActivityBanner(days),
      startAtS,
      fadeInDurationS: 0.4,
    };
  }

  // ── Location tag ───────────────────────────────────────────────────────────

  /**
   * Build a `LocationTag` descriptor.
   *
   * Returns `null` if no location string is provided.
   */
  buildLocationTag(location: string | undefined, startAtS: number): LocationTag | null {
    if (!location || location.trim() === '') return null;

    return {
      label: location.trim(),
      position: { x: 0.5, y: 0.85 },
      startAtS,
      dropDurationS: LOCATION_PIN_DROP_DURATION_S,
      pulseRings: LOCATION_PULSE_RINGS,
      pulseIntervalS: 0.3,
    };
  }

  // ── Main builder ───────────────────────────────────────────────────────────

  /**
   * Build the complete `InterestOverlayPlan` for a user.
   */
  buildOverlayPlan(input: InterestVisualizationInput): InterestOverlayPlan {
    const overlayStartAtS = input.overlayStartAtS ?? 0;

    // Resolve daily activity data.
    let dailyActivity: number[];
    if (input.dailyActivity && input.dailyActivity.length > 0) {
      dailyActivity = input.dailyActivity;
    } else if (input.hourlyActivity && input.hourlyActivity.length > 0) {
      dailyActivity = aggregateHourlyToDays(input.hourlyActivity);
    } else {
      dailyActivity = new Array(HEATMAP_DAYS).fill(1);
    }

    // Wordcloud starts at the overlay offset.
    const wordcloud = this.buildWordcloud(input.interests, overlayStartAtS);

    // Heatmap starts after the wordcloud finishes (with a 0.3 s gap).
    const heatmapStartAtS = overlayStartAtS + wordcloud.totalDurationS + 0.3;
    const heatmap = this.buildHeatmap(dailyActivity, heatmapStartAtS);

    // Location tag starts last (0.5 s after heatmap fade-in).
    const locationStartAtS = heatmapStartAtS + heatmap.fadeInDurationS + 0.5;
    const locationTag = this.buildLocationTag(input.location, locationStartAtS);

    return {
      userId: input.userId,
      wordcloud,
      heatmap,
      locationTag,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  /**
   * Return the top N interest tags by weight.
   */
  topInterests(interests: Record<string, number>, n: number): string[] {
    return Object.entries(interests)
      .filter(([, w]) => w > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n)
      .map(([tag]) => tag);
  }

  /**
   * Produce a human-readable summary of an `InterestOverlayPlan`.
   */
  summarise(plan: InterestOverlayPlan): string {
    const lines: string[] = [
      `InterestOverlayPlan for user ${plan.userId}`,
      `  Wordcloud words : ${plan.wordcloud.words.length}`,
      `  Wordcloud start : ${plan.wordcloud.startAtS}s`,
      `  Heatmap banner  : "${plan.heatmap.bannerText}"`,
      `  Heatmap start   : ${plan.heatmap.startAtS.toFixed(2)}s`,
    ];

    if (plan.locationTag) {
      lines.push(
        `  Location        : "${plan.locationTag.label}" @ ${plan.locationTag.startAtS.toFixed(2)}s`,
      );
    } else {
      lines.push('  Location        : (none)');
    }

    lines.push('  Words:');
    for (const w of plan.wordcloud.words) {
      lines.push(
        `    ${w.icon} ${w.text.padEnd(20)} weight=${w.weight.toFixed(0)} ` +
          `size=${w.fontSizePx}px delay=${w.animationDelayS.toFixed(2)}s`,
      );
    }

    return lines.join('\n');
  }
}
