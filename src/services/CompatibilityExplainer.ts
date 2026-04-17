/**
 * CompatibilityExplainer – converts raw ChemistryPrediction data into
 * human-readable, warm natural-language text.
 *
 * Responsibilities:
 *   1. Map each compatibility dimension to an engaging sentence.
 *   2. Map each friction dimension to a gentle, constructive warning.
 *   3. Suggest tailored conversation starters based on shared interests.
 *
 * All generation is deterministic (template-based with slot filling) so the
 * output is stable across renders and can be safely cached.
 */

import {
  ChemistryPrediction,
  ChemistryUserProfile,
  CompatibilityLabel,
  ChemistryDimension,
} from './ChemistryPredictor';

// ─── Public types ─────────────────────────────────────────────────────────────

/** A fully resolved natural-language explanation for a user pair. */
export interface CompatibilityExplanation {
  /** One-line headline summarising the chemistry score. */
  headline: string;
  /** 2–4 sentence body text highlighting the strongest compatibility dimensions. */
  summary: string;
  /** Natural-language reasons (one per top compatibility dimension). */
  compatibilityReasons: string[];
  /** Gentle friction warnings (one per friction dimension). */
  frictionWarnings: string[];
  /** 3–5 conversation-starter suggestions based on shared interests. */
  conversationStarters: string[];
  /** Deal-breaker flag — true if any friction point scored below 0.25. */
  hasPotentialDealBreaker: boolean;
}

// ─── Score bucket helpers ─────────────────────────────────────────────────────

type ScoreBucket = 'very_low' | 'low' | 'medium' | 'high' | 'very_high';

function bucket(score: number): ScoreBucket {
  if (score >= 0.85) return 'very_high';
  if (score >= 0.65) return 'high';
  if (score >= 0.45) return 'medium';
  if (score >= 0.25) return 'low';
  return 'very_low';
}

function chemistryBucket(score: number): 'low' | 'medium' | 'high' | 'exceptional' {
  if (score >= 80) return 'exceptional';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

// ─── Template libraries ───────────────────────────────────────────────────────

/** Headline templates keyed by overall chemistry bucket. */
const HEADLINES: Record<ReturnType<typeof chemistryBucket>, string[]> = {
  exceptional: [
    'Rare chemistry — the data rarely lies this strongly 🔥',
    'Off-the-charts connection predicted ⚡',
    'You two look exceptionally compatible — worth a conversation',
    'Stellar alignment across nearly every dimension 🌟',
  ],
  high: [
    'Strong chemistry detected — this one could be special ✨',
    'Great match predicted — dive in',
    'The numbers look really good here 💫',
    'High compatibility on multiple dimensions 💚',
  ],
  medium: [
    'Solid foundations — chemistry builds over time',
    'Promising match with a few things to navigate 🌱',
    'Good overlap — interesting conversation ahead',
    'Moderate chemistry — worth exploring',
  ],
  low: [
    'Some differences here — but opposites can attract',
    'Lower chemistry score — could still be a fun chat',
    'Not an obvious match — but surprises happen 🎲',
    'Different styles — curiosity might bridge the gap',
  ],
};

/** Reason templates per compatibility label and score bucket (high/very_high). */
const COMPATIBILITY_TEMPLATES: Record<CompatibilityLabel, Record<ScoreBucket, string>> = {
  shared_interests: {
    very_high: 'You share a remarkably deep overlap of interests — conversations will flow naturally.',
    high:      'Your interest profiles align strongly, giving you plenty of topics to explore together.',
    medium:    'You have a decent set of shared interests — enough common ground to get started.',
    low:       'Your interests differ in several areas, which could spark curiosity or friction.',
    very_low:  'You come from quite different interest worlds — expect some learning curves.',
  },
  communication_style: {
    very_high: 'Your communication styles are almost perfectly in sync — same energy, same rhythm.',
    high:      'You both tend to communicate in similar ways, which means fewer misunderstandings.',
    medium:    'Your communication styles overlap reasonably well with some minor differences.',
    low:       'You communicate quite differently — one of you may feel over- or under-communicated with.',
    very_low:  'Very different communication styles detected — patience and adaptation will matter a lot.',
  },
  activity_timing: {
    very_high: 'You\'re both active at the same hours — no scheduling battles, just spontaneous late-night chats.',
    high:      'Your active hours overlap well, making real-time interaction easy and natural.',
    medium:    'Your schedules have a reasonable overlap, though some coordination may help.',
    low:       'You tend to be online at different times — async messaging might work better than live chat.',
    very_low:  'Almost opposite activity patterns — connecting in real time will need intentional effort.',
  },
  response_speed: {
    very_high: 'You both respond at a similar pace — no one will be left waiting or feeling overwhelmed.',
    high:      'Your response speed expectations are closely aligned — the texting cadence should feel comfortable.',
    medium:    'Moderate speed compatibility — one of you tends to reply a bit faster than the other.',
    low:       'Noticeably different response speeds — one may feel the conversation drags while the other feels rushed.',
    very_low:  'Very different response speeds — this often leads to one person feeling anxious or smothered.',
  },
  humor_alignment: {
    very_high: 'Your humor scores are nearly identical — expect to crack each other up effortlessly 😄',
    high:      'You both have a very similar sense of humor — banter will come easily.',
    medium:    'Your humor styles are broadly compatible with some differences in tone.',
    low:       'Your humor styles diverge — what cracks one of you up might fall flat for the other.',
    very_low:  'Quite different senses of humor — you may need to calibrate expectations around jokes.',
  },
  elo_proximity: {
    very_high: 'You\'re in the same engagement tier — your pacing and expectations for connection are likely similar.',
    high:      'Similar platform engagement levels suggest compatible expectations going in.',
    medium:    'Slight difference in platform engagement tiers — shouldn\'t be a blocker.',
    low:       'Different engagement tiers — one of you is much more active here than the other.',
    very_low:  'Very different engagement histories — one of you may want this much more than the other right now.',
  },
  conversation_depth: {
    very_high: 'You both crave deep, meaningful conversations — get ready to talk for hours.',
    high:      'Strong alignment in preferred conversation depth — neither of you will feel short-changed.',
    medium:    'Reasonable depth compatibility — one may occasionally want to go deeper or keep things lighter.',
    low:       'One of you tends toward deep philosophical chats while the other prefers lighter topics.',
    very_low:  'Major mismatch in conversation depth preference — one may feel drained, the other bored.',
  },
  empathy_match: {
    very_high: 'Both of you score highly on empathy — expect warm, emotionally intelligent conversations.',
    high:      'Strong empathy alignment — you\'ll likely feel understood and validated.',
    medium:    'Decent empathy match — some moments of emotional mis-attunement may occur.',
    low:       'Noticeable empathy gap — one of you may feel unheard at times.',
    very_low:  'Significant empathy mismatch — emotional conversations may feel one-sided.',
  },
};

/** Friction warning templates per label for low/very_low scores. */
const FRICTION_TEMPLATES: Record<CompatibilityLabel, string> = {
  shared_interests:   'Limited shared interests — keeping conversations engaging may take extra effort.',
  communication_style:'Different communication styles — clarify expectations early to avoid frustration.',
  activity_timing:    'Your active hours rarely overlap — real-time connection will require planning.',
  response_speed:     'Big gap in response speed expectations — one of you may feel anxious or smothered.',
  humor_alignment:    'Humor styles diverge — watch for jokes that land differently than intended.',
  elo_proximity:      'Different platform engagement levels — intention and effort may feel unequal.',
  conversation_depth: 'One of you prefers deep talks, the other lighter chat — find a comfortable middle ground.',
  empathy_match:      'Empathy gap detected — emotional conversations may feel one-sided at times.',
};

/** Emoji for each compatibility dimension. */
const DIMENSION_EMOJI: Record<CompatibilityLabel, string> = {
  shared_interests:   '🎯',
  communication_style:'💬',
  activity_timing:    '🌙',
  response_speed:     '⚡',
  humor_alignment:    '😂',
  elo_proximity:      '⚖️',
  conversation_depth: '🧠',
  empathy_match:      '❤️',
};

// ─── Conversation starter templates ──────────────────────────────────────────

/** Generic starters used when no shared interests are identifiable. */
const GENERIC_STARTERS: readonly string[] = [
  'What\'s something you\'re genuinely obsessed with right now?',
  'What does your perfect Saturday look like?',
  'What\'s the last thing that made you laugh out loud?',
  'If you could live anywhere in the world for a year, where would it be?',
  'What\'s a skill you\'ve been meaning to pick up?',
  'What\'s something most people get wrong about you?',
  'What\'s the best piece of advice you\'ve ever received?',
  'What are you reading / watching / listening to lately?',
  'What\'s a topic you could talk about for hours?',
  'What was the highlight of your week?',
];

/**
 * Interest-tag → conversation-starter template pool.
 * Using partial-match logic so "tech" matches "technology", "coding" etc.
 */
const INTEREST_STARTERS: Array<{ keywords: string[]; starters: string[] }> = [
  {
    keywords: ['music', 'guitar', 'piano', 'sing', 'concert', 'band', 'vinyl'],
    starters: [
      'What album has been on repeat for you lately?',
      'Do you prefer live music or studio recordings — and why?',
      'What artist changed how you listen to music?',
      'If you could see any artist (dead or alive) perform live, who would it be?',
    ],
  },
  {
    keywords: ['travel', 'backpack', 'trip', 'adventure', 'explore', 'destination'],
    starters: [
      'What\'s the most underrated place you\'ve visited?',
      'Next trip on your list — where and why?',
      'Do you plan every detail or wing it when you travel?',
      'What\'s a destination that completely surprised you?',
    ],
  },
  {
    keywords: ['tech', 'code', 'programming', 'software', 'engineering', 'ai', 'developer'],
    starters: [
      'What tech project are you most proud of?',
      'Hot take: what\'s the most overhyped technology right now?',
      'What got you into tech in the first place?',
      'Do you think AI will make your work easier or replace it?',
    ],
  },
  {
    keywords: ['film', 'movie', 'cinema', 'director', 'series', 'show', 'netflix', 'streaming'],
    starters: [
      'What\'s a film you could watch over and over?',
      'Which director\'s filmography would you watch start-to-finish?',
      'Best ending to any movie or show you\'ve seen?',
      'What film changed your perspective on something?',
    ],
  },
  {
    keywords: ['food', 'cook', 'chef', 'restaurant', 'bake', 'cuisine', 'recipe'],
    starters: [
      'What\'s your signature dish?',
      'Best meal you\'ve ever had — where and what was it?',
      'Do you cook to relax or is it a chore?',
      'What cuisine could you eat every single day?',
    ],
  },
  {
    keywords: ['fitness', 'gym', 'run', 'yoga', 'sport', 'climb', 'swim', 'cycle'],
    starters: [
      'What does your ideal active Saturday look like?',
      'What got you into fitness?',
      'Do you prefer working out solo or with others?',
      'What\'s the hardest physical challenge you\'ve taken on?',
    ],
  },
  {
    keywords: ['book', 'read', 'novel', 'author', 'fiction', 'nonfiction', 'literature'],
    starters: [
      'What book do you recommend to almost everyone?',
      'Fiction or non-fiction — and what\'s on your nightstand right now?',
      'What\'s a book that genuinely changed how you think?',
      'If you could meet any author, dead or alive, who would it be?',
    ],
  },
  {
    keywords: ['game', 'gaming', 'esports', 'rpg', 'strategy', 'ps5', 'xbox', 'nintendo'],
    starters: [
      'What\'s your all-time favourite game and why?',
      'What game got you into gaming?',
      'Single-player or multiplayer — what\'s your preference?',
      'What game universe would you most want to live in?',
    ],
  },
  {
    keywords: ['art', 'paint', 'draw', 'design', 'photography', 'photo', 'creative'],
    starters: [
      'What creative project are you working on right now?',
      'Who\'s an artist whose work genuinely moves you?',
      'Do you make art for yourself or for an audience?',
      'What\'s the best photo you\'ve ever taken?',
    ],
  },
  {
    keywords: ['night', 'late', 'party', 'social', 'club', 'bar', 'nightlife'],
    starters: [
      'Best late-night adventure you\'ve had?',
      'Are you a person who gets more interesting after midnight?',
      'Best city for nightlife — from your experience?',
      'What do you talk about most when the conversation goes until 3am?',
    ],
  },
];

// ─── CompatibilityExplainer ───────────────────────────────────────────────────

/**
 * Generates natural-language compatibility explanations from ChemistryPrediction data.
 *
 * Designed to be stateless — instantiate once and call `explain` freely.
 */
export class CompatibilityExplainer {
  /**
   * Generate a full CompatibilityExplanation for a user pair.
   *
   * @param profileA   First user profile.
   * @param profileB   Second user profile.
   * @param prediction The ChemistryPrediction returned by ChemistryPredictor.
   * @returns          Human-readable explanation with reasons, warnings, and starters.
   */
  explain(
    profileA: ChemistryUserProfile,
    profileB: ChemistryUserProfile,
    prediction: ChemistryPrediction
  ): CompatibilityExplanation {
    const overallBucket = chemistryBucket(prediction.score);

    const headline = this.pickHeadline(overallBucket, prediction.score);
    const compatibilityReasons = this.buildReasons(prediction.topCompatibilityReasons);
    const frictionWarnings     = this.buildFrictionWarnings(prediction.topFrictionPoints);
    const conversationStarters = this.buildConversationStarters(profileA, profileB);
    const hasPotentialDealBreaker = prediction.topFrictionPoints.some((d) => d.score < 0.25);
    const summary = this.buildSummary(prediction, compatibilityReasons, frictionWarnings);

    return {
      headline,
      summary,
      compatibilityReasons,
      frictionWarnings,
      conversationStarters,
      hasPotentialDealBreaker,
    };
  }

  /**
   * Generate a short emoji-annotated reason string for a single dimension.
   * Useful for inline display inside the ChemistryCard component.
   */
  shortReason(dimension: ChemistryDimension): string {
    const emoji = DIMENSION_EMOJI[dimension.label];
    const template = COMPATIBILITY_TEMPLATES[dimension.label][bucket(dimension.score)];
    const first = template.split('—')[0]?.trim() ?? template;
    return `${emoji} ${first}`;
  }

  /**
   * Generate a short friction warning for a single dimension.
   */
  shortWarning(dimension: ChemistryDimension): string {
    return `⚠️ ${FRICTION_TEMPLATES[dimension.label]}`;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private pickHeadline(
    b: ReturnType<typeof chemistryBucket>,
    score: number
  ): string {
    const pool = HEADLINES[b];
    // Use the score's fractional part as a pseudo-random seed for variety.
    const idx = Math.floor((score % 10) / 10 * pool.length);
    return pool[Math.min(idx, pool.length - 1)]!;
  }

  private buildReasons(dims: readonly ChemistryDimension[]): string[] {
    return dims.slice(0, 3).map((dim) => {
      const b = bucket(dim.score);
      const text = COMPATIBILITY_TEMPLATES[dim.label][b];
      const emoji = DIMENSION_EMOJI[dim.label];
      return `${emoji} ${text}`;
    });
  }

  private buildFrictionWarnings(dims: readonly ChemistryDimension[]): string[] {
    // Only surface warnings for genuinely low scores to avoid false alarms.
    return dims
      .filter((d) => d.score < 0.55)
      .slice(0, 2)
      .map((dim) => `⚠️ ${FRICTION_TEMPLATES[dim.label]}`);
  }

  private buildConversationStarters(
    profileA: ChemistryUserProfile,
    profileB: ChemistryUserProfile
  ): string[] {
    // Find interest keys that appear in both profiles.
    const sharedKeys = Object.keys(profileA.interests).filter(
      (k) => (profileA.interests[k] ?? 0) > 0 && (profileB.interests[k] ?? 0) > 0
    );

    const starters: string[] = [];

    // Try to match shared interests to template pools.
    for (const key of sharedKeys) {
      if (starters.length >= 5) break;
      const lower = key.toLowerCase();
      for (const pool of INTEREST_STARTERS) {
        if (pool.keywords.some((kw) => lower.includes(kw))) {
          const picked = this.pickFromPool(pool.starters, starters);
          if (picked) starters.push(picked);
          break;
        }
      }
    }

    // Fill remaining slots with generic starters.
    const shuffledGeneric = this.deterministicShuffle(GENERIC_STARTERS, sharedKeys.length);
    for (const s of shuffledGeneric) {
      if (starters.length >= 5) break;
      if (!starters.includes(s)) starters.push(s);
    }

    return starters.slice(0, 5);
  }

  /** Pick a starter from a pool that hasn't been selected yet. */
  private pickFromPool(pool: readonly string[], alreadyPicked: readonly string[]): string | null {
    for (const s of pool) {
      if (!alreadyPicked.includes(s)) return s;
    }
    return null;
  }

  /**
   * Deterministic shuffle using a simple seed so output is stable per user pair.
   * Seed is derived from the number of shared interests.
   */
  private deterministicShuffle<T>(arr: readonly T[], seed: number): T[] {
    const copy = [...arr];
    let s = seed + 1;
    for (let i = copy.length - 1; i > 0; i--) {
      s = ((s * 1103515245) + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      const tmp = copy[i]!;
      copy[i] = copy[j]!;
      copy[j] = tmp;
    }
    return copy;
  }

  private buildSummary(
    prediction: ChemistryPrediction,
    reasons: readonly string[],
    warnings: readonly string[]
  ): string {
    const scoreStr = prediction.score.toFixed(0);
    const confPct  = (prediction.confidence * 100).toFixed(0);

    const topReason = reasons[0] ?? '';
    const secondReason = reasons[1] ?? '';

    const base = `Our AI gives you a ${scoreStr}/100 chemistry score (${confPct}% confidence). `;
    const highlight = topReason
      ? `${topReason.replace(/^[^ ]+ /, '')} `
      : '';
    const second = secondReason
      ? `${secondReason.replace(/^[^ ]+ /, '')} `
      : '';
    const caution = warnings.length > 0
      ? `One area to navigate: ${warnings[0]!.replace('⚠️ ', '')}`
      : 'No significant friction points detected.';

    return `${base}${highlight}${second}${caution}`.trim();
  }
}
