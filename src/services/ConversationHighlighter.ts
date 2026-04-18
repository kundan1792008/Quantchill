/**
 * ConversationHighlighter – extracts and formats the most engaging messages
 * from a user's chat history for display as animated quote cards in the video
 * dating profile reel.
 *
 * Selection criteria:
 *   • Received laughter-emoji responses (😂, 🤣, 😄, 😆, haha, lol, lmao).
 *   • Message length sweet spot: 2–3 sentences (~20–120 words).
 *   • High sentiment variety (not purely neutral).
 *
 * Privacy rules:
 *   • All participant names / handles other than the profile owner are
 *     replaced with a generic label ("Someone").
 *   • Phone numbers, emails, and URLs are redacted with [REDACTED].
 *   • Usernames starting with @ are replaced with @someone.
 *
 * Output:
 *   Each selected message becomes a `QuoteCard` with a typing-effect
 *   animation descriptor so the renderer can replay it character-by-character.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of quote cards shown in the reel. */
export const MAX_QUOTE_CARDS = 3;

/** Minimum word count for a message to be considered. */
export const MIN_WORD_COUNT = 8;

/** Maximum word count for a message to be considered. */
export const MAX_WORD_COUNT = 120;

/** Score boost applied when a message received a laughter-emoji reaction. */
export const LAUGHTER_BOOST = 40;

/** Score boost per sentence (capped at 3 sentences). */
export const SENTENCE_SCORE_PER = 10;

/** Score penalty per word beyond the sweet-spot upper bound. */
export const OVER_LENGTH_PENALTY_PER_WORD = 0.5;

/** Typing speed in characters per second (for animation). */
export const TYPING_SPEED_CPS = 30;

/** Pause inserted between successive quote-card animations (seconds). */
export const CARD_PAUSE_S = 0.8;

// ─── Regex patterns ───────────────────────────────────────────────────────────

/** Matches common laughter emoji and text equivalents. */
const LAUGHTER_PATTERN =
  /😂|🤣|😄|😆|😹|😸|haha+|hehe+|lol+|lmao+|rofl+|🤭/i;

/** Regex for phone numbers (E.164 and common national formats). */
const PHONE_PATTERN =
  /(\+?\d[\d\s\-().]{7,}\d)/g;

/** Regex for email addresses. */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/** Regex for URLs. */
const URL_PATTERN =
  /https?:\/\/[^\s]+|www\.[^\s]+/gi;

/** Regex for @mentions. */
const MENTION_PATTERN = /@[A-Za-z0-9_]+/g;

// ─── Public types ─────────────────────────────────────────────────────────────

/** A single message in a conversation. */
export interface ChatMessage {
  /** Unique identifier. */
  id: string;
  /** ID of the user who authored this message. */
  authorId: string;
  /** Display name of the author (will be redacted if not the profile owner). */
  authorName: string;
  /** Raw message text. */
  text: string;
  /** ISO 8601 timestamp. */
  sentAt: string;
  /** Emoji/text reactions received by this message. */
  reactions?: string[];
}

/** A scored, sanitised message ready for display. */
export interface ScoredMessage {
  message: ChatMessage;
  /** Engagement score [0, ∞). */
  score: number;
  /** Whether at least one laughter reaction was received. */
  hasLaughterReaction: boolean;
  /** Number of sentences detected. */
  sentenceCount: number;
  /** Number of words. */
  wordCount: number;
  /** Sanitised text with PII removed. */
  sanitisedText: string;
}

// ─── Animation types ──────────────────────────────────────────────────────────

/** Typing-effect animation descriptor for a single card. */
export interface TypingAnimation {
  /** Total characters to type. */
  totalChars: number;
  /** Typing speed in characters per second. */
  speedCps: number;
  /** Duration for the cursor to blink after typing completes (seconds). */
  cursorBlinkDurationS: number;
  /** Total animation duration (seconds). */
  totalDurationS: number;
}

/** A single animated quote card. */
export interface QuoteCard {
  /** Zero-based position in the card sequence. */
  index: number;
  /** Sanitised quote text. */
  text: string;
  /** Typing effect animation parameters. */
  typingAnimation: TypingAnimation;
  /** Time offset (seconds) within the reel when this card appears. */
  startAtS: number;
  /** Whether this message received a laughter reaction. */
  hasLaughterReaction: boolean;
  /** Accent colour for the card border / highlight. */
  accentColor: string;
}

/** The complete highlight extraction result. */
export interface ConversationHighlight {
  /** User ID whose highlights these are. */
  userId: string;
  /** Selected and formatted quote cards. */
  cards: QuoteCard[];
  /** Total time all cards occupy in the reel (seconds). */
  totalDurationS: number;
  /** ISO 8601 timestamp of extraction. */
  extractedAt: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/** Count sentences by splitting on terminal punctuation. */
function countSentences(text: string): number {
  const matches = text.match(/[^.!?]*[.!?]+/g);
  if (!matches || matches.length === 0) return 1;
  return matches.length;
}

/** Return true if any reaction (or the message itself) contains a laughter signal. */
function hasLaughter(message: ChatMessage): boolean {
  if (LAUGHTER_PATTERN.test(message.text)) return true;
  if (message.reactions) {
    return message.reactions.some((r) => LAUGHTER_PATTERN.test(r));
  }
  return false;
}

/** Remove PII from a message text. */
function sanitise(text: string, profileOwnerId: string, ownerName: string): string {
  let out = text;

  // Replace phone numbers.
  out = out.replace(PHONE_PATTERN, '[REDACTED]');

  // Replace emails.
  out = out.replace(EMAIL_PATTERN, '[REDACTED]');

  // Replace URLs.
  out = out.replace(URL_PATTERN, '[REDACTED]');

  // Replace @mentions (but keep the profile owner's handle if it appears).
  out = out.replace(MENTION_PATTERN, (match) => {
    const handle = match.slice(1).toLowerCase();
    if (handle === ownerName.toLowerCase() || handle === profileOwnerId.toLowerCase()) {
      return match;
    }
    return '@someone';
  });

  return out;
}

/** Accent colours for quote cards (rotating palette). */
const CARD_ACCENT_COLORS: readonly string[] = [
  '#a78bfa',
  '#38bdf8',
  '#34d399',
  '#fb923c',
  '#f472b6',
];

// ─── ConversationHighlighter ──────────────────────────────────────────────────

/**
 * Stateless service — call `extract()` with a user's chat history to receive
 * a `ConversationHighlight` containing up to `MAX_QUOTE_CARDS` animated cards.
 */
export class ConversationHighlighter {
  // ── Scoring ────────────────────────────────────────────────────────────────

  /**
   * Score a single message for engagement quality.
   *
   * Returns `null` if the message does not meet the minimum criteria.
   */
  scoreMessage(
    message: ChatMessage,
    profileOwnerId: string,
    profileOwnerName: string,
  ): ScoredMessage | null {
    // Only score messages authored by the profile owner.
    if (message.authorId !== profileOwnerId) return null;

    const wordCount = countWords(message.text);
    if (wordCount < MIN_WORD_COUNT) return null;

    // Messages that are excessively long are capped, not excluded.
    const sentenceCount = countSentences(message.text);
    const laughter = hasLaughter(message);

    // Base score: word count in sweet spot + sentence count bonus.
    const clampedSentences = Math.min(sentenceCount, 3);
    let score = clampedSentences * SENTENCE_SCORE_PER;

    // Laughter boost.
    if (laughter) score += LAUGHTER_BOOST;

    // Over-length penalty (per word over MAX_WORD_COUNT).
    if (wordCount > MAX_WORD_COUNT) {
      score -= (wordCount - MAX_WORD_COUNT) * OVER_LENGTH_PENALTY_PER_WORD;
    }

    // Ensure score is non-negative.
    score = Math.max(0, score);

    const sanitisedText = sanitise(
      message.text,
      profileOwnerId,
      profileOwnerName,
    );

    return {
      message,
      score,
      hasLaughterReaction: laughter,
      sentenceCount,
      wordCount,
      sanitisedText,
    };
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  /**
   * Score all messages and return the top `MAX_QUOTE_CARDS` by engagement.
   *
   * Enforces chronological variety: no two consecutive selected messages
   * should be from the same conversation thread.
   */
  selectTopMessages(
    messages: ChatMessage[],
    profileOwnerId: string,
    profileOwnerName: string,
  ): ScoredMessage[] {
    const scored: ScoredMessage[] = [];

    for (const msg of messages) {
      const result = this.scoreMessage(msg, profileOwnerId, profileOwnerName);
      if (result !== null) scored.push(result);
    }

    // Sort descending by score.
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, MAX_QUOTE_CARDS);
  }

  // ── Animation building ────────────────────────────────────────────────────

  /**
   * Build the `TypingAnimation` descriptor for a piece of text.
   */
  buildTypingAnimation(text: string): TypingAnimation {
    const totalChars = text.length;
    const typingDurationS = totalChars / TYPING_SPEED_CPS;
    const cursorBlinkDurationS = 1.2;

    return {
      totalChars,
      speedCps: TYPING_SPEED_CPS,
      cursorBlinkDurationS,
      totalDurationS: typingDurationS + cursorBlinkDurationS,
    };
  }

  // ── Quote card building ───────────────────────────────────────────────────

  /**
   * Convert a list of scored messages into a sequence of `QuoteCard` objects
   * with correct timing offsets.
   *
   * @param startAtS  Time offset (seconds) within the reel for the first card.
   */
  buildQuoteCards(
    scoredMessages: ScoredMessage[],
    startAtS: number,
  ): QuoteCard[] {
    const cards: QuoteCard[] = [];
    let currentTime = startAtS;

    scoredMessages.forEach((sm, idx) => {
      const animation = this.buildTypingAnimation(sm.sanitisedText);

      cards.push({
        index: idx,
        text: sm.sanitisedText,
        typingAnimation: animation,
        startAtS: currentTime,
        hasLaughterReaction: sm.hasLaughterReaction,
        accentColor:
          CARD_ACCENT_COLORS[idx % CARD_ACCENT_COLORS.length]!,
      });

      currentTime += animation.totalDurationS + CARD_PAUSE_S;
    });

    return cards;
  }

  // ── Main entry ────────────────────────────────────────────────────────────

  /**
   * Extract conversation highlights from a chat history.
   *
   * @param userId            Profile owner's user ID.
   * @param ownerName         Profile owner's display name (for mention handling).
   * @param messages          Full chat history (may include messages by others).
   * @param reelStartAtS      Time offset within the reel where cards begin.
   */
  extract(
    userId: string,
    ownerName: string,
    messages: ChatMessage[],
    reelStartAtS: number = 0,
  ): ConversationHighlight {
    const selected = this.selectTopMessages(messages, userId, ownerName);
    const cards = this.buildQuoteCards(selected, reelStartAtS);

    const totalDurationS =
      cards.length > 0
        ? cards[cards.length - 1]!.startAtS +
          cards[cards.length - 1]!.typingAnimation.totalDurationS -
          reelStartAtS
        : 0;

    return {
      userId,
      cards,
      totalDurationS,
      extractedAt: new Date().toISOString(),
    };
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /**
   * Sanitise a single text string (exposed for testing / reuse).
   */
  sanitiseText(
    text: string,
    profileOwnerId: string,
    ownerName: string,
  ): string {
    return sanitise(text, profileOwnerId, ownerName);
  }

  /**
   * Return a human-readable summary of a `ConversationHighlight`.
   */
  summarise(highlight: ConversationHighlight): string {
    const lines: string[] = [
      `ConversationHighlight for user ${highlight.userId}`,
      `  Cards        : ${highlight.cards.length}`,
      `  Total time   : ${highlight.totalDurationS.toFixed(2)}s`,
      `  Extracted at : ${highlight.extractedAt}`,
      '',
      '  Cards:',
    ];

    for (const card of highlight.cards) {
      const preview = card.text.slice(0, 60).replace(/\n/g, ' ');
      const ellipsis = card.text.length > 60 ? '…' : '';
      lines.push(
        `    [${card.index}] "${preview}${ellipsis}" ` +
          `laugh=${card.hasLaughterReaction} ` +
          `startAt=${card.startAtS.toFixed(2)}s ` +
          `duration=${card.typingAnimation.totalDurationS.toFixed(2)}s`,
      );
    }

    return lines.join('\n');
  }
}
