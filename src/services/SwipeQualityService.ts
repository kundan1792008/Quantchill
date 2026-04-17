/**
 * SwipeQualityService – detect low-quality (low-attention) swiping and
 * produce signals that downweight those swipes in downstream matching,
 * plus opt-in break suggestions and a daily usage-awareness summary.
 *
 * Explicit non-goals (by design, to avoid dark patterns):
 *   - No forced cooldown. We never block a user from swiping.
 *   - No currency loss. We never penalize users financially or with
 *     consumable credits for swiping quickly.
 *   - No streaks / "don't lose your streak" framing. The daily summary is
 *     descriptive, not motivational.
 *   - No pushed notifications. Break suggestions are returned in API
 *     responses; the client decides whether (and how gently) to display.
 *   - Superlike reset time is returned as an ISO timestamp – information,
 *     not a countdown-pressure UI.
 */

/** A single swipe observation used to assess decision quality. */
export interface SwipeObservation {
  /** Unix ms timestamp at which the swipe was committed. */
  timestamp: number;
  /**
   * Time, in ms, between the swipe target becoming visible and the user
   * committing a decision. This is the primary signal for "quality".
   */
  decisionTimeMs: number;
}

/** Result for a single swipe ingested via {@link SwipeQualityService.recordSwipe}. */
export interface SwipeQualityResult {
  /**
   * Confidence weight in [0, 1] to apply to this swipe in downstream signals
   * (e.g., GemmaEngine eloAdjustment, interest-graph updates). `1` means
   * fully weighted; `0` means the swipe is informational only.
   */
  weight: number;
  /**
   * True when the rolling-window median decision time is below the
   * low-quality threshold. When true, the client MAY (not must) surface a
   * gentle, dismissible "take a break?" suggestion if the user has opted
   * into `breakRemindersEnabled`.
   */
  takeABreakSuggested: boolean;
  /** Median decision time over the current window, in ms. */
  medianDecisionTimeMs: number;
  /** Sample size used to compute the median. */
  windowSize: number;
}

/** Daily usage-awareness summary. */
export interface DailyUsageSummary {
  /** ISO date (YYYY-MM-DD) in UTC this summary covers. */
  date: string;
  /** Number of swipes recorded. */
  swipes: number;
  /**
   * Active time in minutes, estimated as the sum of inter-swipe gaps capped at
   * {@link ACTIVE_GAP_CAP_MS}. This avoids counting time during which the app
   * was backgrounded as "active use".
   */
  activeMinutes: number;
  /** Matches confirmed today (caller-provided). */
  matches: number;
  /** New conversations started today (caller-provided). */
  newConversations: number;
  /**
   * The user's configured soft daily limit in minutes, or null if none.
   * Enforcement is advisory only – we surface this so the UI can warn.
   */
  dailyTimeLimitMinutes: number | null;
  /** True when `activeMinutes >= dailyTimeLimitMinutes`. */
  limitReached: boolean;
}

/** Superlike allotment state for a user. */
export interface SuperlikeState {
  /** Remaining superlikes in the current UTC day. */
  remaining: number;
  /** Daily quota (constant). */
  dailyQuota: number;
  /** ISO 8601 timestamp (UTC midnight tomorrow) at which the quota resets. */
  resetsAt: string;
}

// ─── Configuration constants ─────────────────────────────────────────────────

/**
 * Rolling window size used for median decision-time calculation. Chosen to
 * smooth over short bursts while still being responsive within one session.
 */
export const QUALITY_WINDOW_SIZE = 20;

/**
 * Median decision time (ms) below which swipes in the window are considered
 * low-quality. 300 ms is well below the threshold at which a user can have
 * meaningfully processed a profile photo + bio: human visual-recognition
 * studies put basic scene gist at ~100–150 ms, and reading even a short bio
 * line adds several hundred ms on top. A 300 ms median therefore indicates
 * decisions driven by thumb momentum rather than content. Tune with product
 * data; this is a starting heuristic, not a research-derived constant.
 */
export const LOW_QUALITY_MEDIAN_MS = 300;

/**
 * Weight applied to swipes committed during a low-quality window. A small
 * positive weight is preferred to zero so that the signal still contributes
 * (users may be genuinely fast), just with reduced influence.
 */
export const LOW_QUALITY_WEIGHT = 0.25;

/**
 * Maximum inter-swipe gap, in ms, counted as "active" time. Gaps longer than
 * this are capped to avoid inflating active-minutes when the app is
 * backgrounded or the user walks away.
 *
 * 90 s chosen as a conservative upper bound on a "reading a long bio +
 * looking at multiple photos" pause. Any gap larger than that is much more
 * likely to be distraction / background / context-switch time than active
 * use, and counting it would make the daily summary misleading in the
 * direction that matters most for wellbeing (over-reporting time spent).
 */
export const ACTIVE_GAP_CAP_MS = 90_000;

/** Default Superlike daily quota. Product can override per constructor arg. */
export const DEFAULT_SUPERLIKE_QUOTA = 3;

// ─── Pure helpers (exported for unit tests) ──────────────────────────────────

/** Compute the median of a numeric array. Non-destructive. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute the next UTC-midnight ISO timestamp strictly after `now`. Used as
 * the Superlike reset time. Using UTC avoids the family of DST bugs that
 * would otherwise occur around time-zone transitions.
 */
export function nextUtcMidnightIso(now: Date = new Date()): string {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0
    )
  );
  return next.toISOString();
}

/** ISO date (YYYY-MM-DD) in UTC for a given instant. */
export function utcDateKey(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ─── Service ─────────────────────────────────────────────────────────────────

interface DailyBucket {
  date: string;
  observations: SwipeObservation[];
  matches: number;
  newConversations: number;
  superlikesUsed: number;
}

export interface SwipeQualityServiceOptions {
  superlikeQuota?: number;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Optional settings provider used for daily-limit enforcement in summaries. */
  settings?: {
    get(userId: string): { dailyTimeLimitMinutes: number | null };
  };
}

export class SwipeQualityService {
  private readonly windows = new Map<string, SwipeObservation[]>();
  private readonly daily = new Map<string, DailyBucket>();
  private readonly superlikeQuota: number;
  private readonly now: () => number;
  private readonly settings?: SwipeQualityServiceOptions['settings'];

  constructor(options: SwipeQualityServiceOptions = {}) {
    this.superlikeQuota = options.superlikeQuota ?? DEFAULT_SUPERLIKE_QUOTA;
    this.now = options.now ?? (() => Date.now());
    this.settings = options.settings;
  }

  /**
   * Ingest a swipe observation. Updates the rolling window and returns the
   * confidence weight + a (non-blocking) break-suggestion flag.
   */
  recordSwipe(userId: string, observation: SwipeObservation): SwipeQualityResult {
    if (observation.decisionTimeMs < 0 || !Number.isFinite(observation.decisionTimeMs)) {
      throw new Error('decisionTimeMs must be a non-negative finite number');
    }
    const window = this.windows.get(userId) ?? [];
    window.push(observation);
    if (window.length > QUALITY_WINDOW_SIZE) {
      window.splice(0, window.length - QUALITY_WINDOW_SIZE);
    }
    this.windows.set(userId, window);

    const bucket = this.getBucket(userId);
    bucket.observations.push(observation);

    const med = median(window.map((o) => o.decisionTimeMs));
    const lowQuality = window.length >= Math.min(5, QUALITY_WINDOW_SIZE) && med < LOW_QUALITY_MEDIAN_MS;

    return {
      weight: lowQuality ? LOW_QUALITY_WEIGHT : 1,
      takeABreakSuggested: lowQuality,
      medianDecisionTimeMs: med,
      windowSize: window.length
    };
  }

  /** Record that a match was confirmed today. Used by the daily summary. */
  recordMatch(userId: string): void {
    this.getBucket(userId).matches += 1;
  }

  /** Record that a new conversation was started today. */
  recordNewConversation(userId: string): void {
    this.getBucket(userId).newConversations += 1;
  }

  /**
   * Attempt to spend one Superlike. Returns true on success, false if the
   * user has already used their daily quota. No hidden costs, no currency
   * loss. The UI must display {@link getSuperlikeState} for transparency.
   */
  consumeSuperlike(userId: string): boolean {
    const bucket = this.getBucket(userId);
    if (bucket.superlikesUsed >= this.superlikeQuota) return false;
    bucket.superlikesUsed += 1;
    return true;
  }

  /** Return the user's current Superlike allotment state. */
  getSuperlikeState(userId: string): SuperlikeState {
    const bucket = this.getBucket(userId);
    return {
      remaining: Math.max(0, this.superlikeQuota - bucket.superlikesUsed),
      dailyQuota: this.superlikeQuota,
      resetsAt: nextUtcMidnightIso(new Date(this.now()))
    };
  }

  /**
   * Return today's usage-awareness summary for a user.
   *
   * This summary is opt-in at the UI layer via
   * `UserWellbeingSettings.breakRemindersEnabled`. The server will compute
   * and return it whenever asked; respecting the opt-in is the caller's
   * responsibility so that auditing tools can still inspect their own data.
   */
  getDailyUsageSummary(userId: string): DailyUsageSummary {
    const bucket = this.getBucket(userId);
    const activeMinutes = this.computeActiveMinutes(bucket.observations);
    const dailyLimit = this.settings?.get(userId).dailyTimeLimitMinutes ?? null;

    return {
      date: bucket.date,
      swipes: bucket.observations.length,
      activeMinutes,
      matches: bucket.matches,
      newConversations: bucket.newConversations,
      dailyTimeLimitMinutes: dailyLimit,
      limitReached: dailyLimit !== null && activeMinutes >= dailyLimit
    };
  }

  /**
   * Estimate active minutes from a sequence of swipe observations by summing
   * inter-event gaps capped at {@link ACTIVE_GAP_CAP_MS}. A single swipe
   * counts as 0 active minutes (we cannot infer duration from one event).
   */
  private computeActiveMinutes(observations: readonly SwipeObservation[]): number {
    if (observations.length < 2) return 0;
    const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
    let totalMs = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].timestamp - sorted[i - 1].timestamp;
      totalMs += Math.min(Math.max(0, gap), ACTIVE_GAP_CAP_MS);
    }
    return Math.round(totalMs / 60_000);
  }

  /** Fetch (and roll over if the day changed) the user's daily bucket. */
  private getBucket(userId: string): DailyBucket {
    const today = utcDateKey(new Date(this.now()));
    const existing = this.daily.get(userId);
    if (existing && existing.date === today) return existing;
    const fresh: DailyBucket = {
      date: today,
      observations: [],
      matches: 0,
      newConversations: 0,
      superlikesUsed: 0
    };
    this.daily.set(userId, fresh);
    return fresh;
  }
}
