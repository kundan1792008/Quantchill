import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationHighlighter,
  ChatMessage,
  MAX_QUOTE_CARDS,
  MIN_WORD_COUNT,
  TYPING_SPEED_CPS,
  LAUGHTER_BOOST,
} from '../src/services/ConversationHighlighter';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _msgId = 0;

function makeMessage(
  authorId: string,
  text: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `msg-${++_msgId}`,
    authorId,
    authorName: authorId === 'owner' ? 'Alice' : 'Bob',
    text,
    sentAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A decent-length message that should pass filters. */
const GOOD_TEXT =
  'I recently started learning to cook Italian food and it has been a delightful journey. ' +
  'Last weekend I made homemade pasta from scratch. It tasted amazing!';

const WITTY_TEXT =
  'Okay so here is the thing — every time I try to be serious about fitness I end up in a ' +
  'deep rabbit hole watching competitive dog-agility videos instead. Three hours later and ' +
  'somehow I know the training regimen of a border collie named Splash.';

// ─── Tests ────────────────────────────────────────────────────────────────────

test('ConversationHighlighter: extract returns up to MAX_QUOTE_CARDS cards', () => {
  const hl = new ConversationHighlighter();
  const messages: ChatMessage[] = [];

  for (let i = 0; i < 10; i++) {
    messages.push(makeMessage('owner', GOOD_TEXT));
  }

  const result = hl.extract('owner', 'Alice', messages);
  assert.ok(result.cards.length <= MAX_QUOTE_CARDS);
});

test('ConversationHighlighter: extract ignores messages from others', () => {
  const hl = new ConversationHighlighter();
  const messages: ChatMessage[] = [
    makeMessage('other', GOOD_TEXT),
    makeMessage('other', WITTY_TEXT),
    makeMessage('owner', GOOD_TEXT),
  ];

  const result = hl.extract('owner', 'Alice', messages);
  // Only the owner's message qualifies
  assert.ok(result.cards.length <= 1);
});

test('ConversationHighlighter: extract ignores messages below MIN_WORD_COUNT', () => {
  const hl = new ConversationHighlighter();
  const shortMsg = makeMessage('owner', 'Hi there!'); // < MIN_WORD_COUNT words
  const longMsg = makeMessage('owner', GOOD_TEXT);

  const result = hl.extract('owner', 'Alice', [shortMsg, longMsg]);
  // shortMsg should not appear in cards
  for (const card of result.cards) {
    assert.ok(card.text.length > 'Hi there!'.length);
  }
});

test('ConversationHighlighter: laughter reactions boost score', () => {
  const hl = new ConversationHighlighter();

  // Use identical base text so the only difference is the laughter reaction.
  const laughterMsg = makeMessage('owner', GOOD_TEXT, {
    reactions: ['😂'],
  });
  const normalMsg = makeMessage('owner', GOOD_TEXT);

  const scoredLaughter = hl.scoreMessage(laughterMsg, 'owner', 'Alice');
  const scoredNormal = hl.scoreMessage(normalMsg, 'owner', 'Alice');

  assert.ok(scoredLaughter !== null);
  assert.ok(scoredNormal !== null);
  assert.ok(
    scoredLaughter!.score - scoredNormal!.score >= LAUGHTER_BOOST - 1,
    'laughter reaction should boost score by approximately LAUGHTER_BOOST',
  );
});

test('ConversationHighlighter: hasLaughterReaction is true when emoji present', () => {
  const hl = new ConversationHighlighter();

  const msg = makeMessage('owner', GOOD_TEXT, { reactions: ['🤣'] });
  const scored = hl.scoreMessage(msg, 'owner', 'Alice');

  assert.ok(scored !== null);
  assert.equal(scored!.hasLaughterReaction, true);
});

test('ConversationHighlighter: hasLaughterReaction detects text patterns', () => {
  const hl = new ConversationHighlighter();

  const haha = makeMessage(
    'owner',
    GOOD_TEXT + ' haha that was so funny',
  );
  const scored = hl.scoreMessage(haha, 'owner', 'Alice');

  assert.ok(scored !== null);
  assert.equal(scored!.hasLaughterReaction, true);
});

test('ConversationHighlighter: scoreMessage returns null for short messages', () => {
  const hl = new ConversationHighlighter();
  const short = makeMessage('owner', 'Short.');
  const result = hl.scoreMessage(short, 'owner', 'Alice');

  assert.equal(result, null);
});

test('ConversationHighlighter: scoreMessage returns null for other-authored messages', () => {
  const hl = new ConversationHighlighter();
  const msg = makeMessage('other', GOOD_TEXT);
  const result = hl.scoreMessage(msg, 'owner', 'Alice');

  assert.equal(result, null);
});

test('ConversationHighlighter: sanitiseText removes phone numbers', () => {
  const hl = new ConversationHighlighter();
  const text = 'Call me at +1 (555) 123-4567 anytime.';
  const sanitised = hl.sanitiseText(text, 'owner', 'Alice');

  assert.ok(!sanitised.includes('555'));
  assert.ok(sanitised.includes('[REDACTED]'));
});

test('ConversationHighlighter: sanitiseText removes emails', () => {
  const hl = new ConversationHighlighter();
  const text = 'My email is alice@example.com, reach out!';
  const sanitised = hl.sanitiseText(text, 'owner', 'Alice');

  assert.ok(!sanitised.includes('alice@example.com'));
  assert.ok(sanitised.includes('[REDACTED]'));
});

test('ConversationHighlighter: sanitiseText removes URLs', () => {
  const hl = new ConversationHighlighter();
  const text = 'Check this out: https://example.com/page';
  const sanitised = hl.sanitiseText(text, 'owner', 'Alice');

  // Verify the original domain is gone and replaced with the redaction token.
  assert.ok(!sanitised.includes('example.com'));
  assert.ok(sanitised.includes('[REDACTED]'));
});

test('ConversationHighlighter: sanitiseText anonymises @mentions', () => {
  const hl = new ConversationHighlighter();
  const text = 'Hey @bob and @charlie, come to the party!';
  const sanitised = hl.sanitiseText(text, 'owner', 'Alice');

  assert.ok(!sanitised.includes('@bob'));
  assert.ok(!sanitised.includes('@charlie'));
  assert.ok(sanitised.includes('@someone'));
});

test('ConversationHighlighter: buildTypingAnimation has correct total duration', () => {
  const hl = new ConversationHighlighter();
  const text = 'Hello, this is a test message!';
  const anim = hl.buildTypingAnimation(text);

  const expectedTypingS = text.length / TYPING_SPEED_CPS;
  assert.ok(
    Math.abs(anim.totalDurationS - (expectedTypingS + anim.cursorBlinkDurationS)) < 0.001,
  );
  assert.equal(anim.totalChars, text.length);
  assert.equal(anim.speedCps, TYPING_SPEED_CPS);
});

test('ConversationHighlighter: buildQuoteCards assigns sequential indices', () => {
  const hl = new ConversationHighlighter();
  const messages: ChatMessage[] = [
    makeMessage('owner', GOOD_TEXT),
    makeMessage('owner', WITTY_TEXT),
  ];
  const scored = hl.selectTopMessages(messages, 'owner', 'Alice');
  const cards = hl.buildQuoteCards(scored, 0);

  cards.forEach((card, i) => {
    assert.equal(card.index, i);
  });
});

test('ConversationHighlighter: buildQuoteCards start times are increasing', () => {
  const hl = new ConversationHighlighter();
  const messages: ChatMessage[] = [
    makeMessage('owner', GOOD_TEXT),
    makeMessage('owner', WITTY_TEXT),
  ];
  const scored = hl.selectTopMessages(messages, 'owner', 'Alice');
  const cards = hl.buildQuoteCards(scored, 0);

  for (let i = 1; i < cards.length; i++) {
    assert.ok(cards[i]!.startAtS > cards[i - 1]!.startAtS);
  }
});

test('ConversationHighlighter: extract with no eligible messages returns empty cards', () => {
  const hl = new ConversationHighlighter();
  // All messages are too short
  const messages: ChatMessage[] = [
    makeMessage('owner', 'Hi!'),
    makeMessage('owner', 'OK'),
    makeMessage('other', GOOD_TEXT), // from other user
  ];

  const result = hl.extract('owner', 'Alice', messages);
  assert.equal(result.cards.length, 0);
  assert.equal(result.totalDurationS, 0);
});

test('ConversationHighlighter: extract totalDurationS matches card timing', () => {
  const hl = new ConversationHighlighter();
  const messages: ChatMessage[] = [makeMessage('owner', GOOD_TEXT)];
  const result = hl.extract('owner', 'Alice', messages, 0);

  if (result.cards.length > 0) {
    const lastCard = result.cards[result.cards.length - 1]!;
    const expected =
      lastCard.startAtS + lastCard.typingAnimation.totalDurationS;
    assert.ok(Math.abs(result.totalDurationS - expected) < 0.001);
  }
});

test('ConversationHighlighter: extract respects reelStartAtS offset', () => {
  const hl = new ConversationHighlighter();
  const messages: ChatMessage[] = [makeMessage('owner', GOOD_TEXT)];
  const result = hl.extract('owner', 'Alice', messages, 5);

  if (result.cards.length > 0) {
    assert.ok(result.cards[0]!.startAtS >= 5);
  }
});

test('ConversationHighlighter: extract cards have accentColor set', () => {
  const hl = new ConversationHighlighter();
  const messages = [makeMessage('owner', GOOD_TEXT)];
  const result = hl.extract('owner', 'Alice', messages);

  for (const card of result.cards) {
    assert.ok(card.accentColor.startsWith('#'));
  }
});

test('ConversationHighlighter: summarise returns non-empty string', () => {
  const hl = new ConversationHighlighter();
  const messages = [makeMessage('owner', GOOD_TEXT)];
  const highlight = hl.extract('owner', 'Alice', messages);
  const summary = hl.summarise(highlight);

  assert.ok(summary.length > 0);
  assert.ok(summary.includes('owner'));
});

test('ConversationHighlighter: min word count boundary — exactly MIN_WORD_COUNT words', () => {
  const hl = new ConversationHighlighter();
  // Build a message with exactly MIN_WORD_COUNT words
  const words = Array.from({ length: MIN_WORD_COUNT }, (_, i) => `word${i}`);
  const text = words.join(' ');
  const msg = makeMessage('owner', text);

  const scored = hl.scoreMessage(msg, 'owner', 'Alice');
  assert.ok(scored !== null, 'message with exactly MIN_WORD_COUNT words should be eligible');
});

test('ConversationHighlighter: message one word below minimum is rejected', () => {
  const hl = new ConversationHighlighter();
  const words = Array.from({ length: MIN_WORD_COUNT - 1 }, (_, i) => `word${i}`);
  const text = words.join(' ');
  const msg = makeMessage('owner', text);

  const scored = hl.scoreMessage(msg, 'owner', 'Alice');
  assert.equal(scored, null);
});

test('ConversationHighlighter: empty message history produces empty result', () => {
  const hl = new ConversationHighlighter();
  const result = hl.extract('owner', 'Alice', []);

  assert.equal(result.cards.length, 0);
  assert.equal(result.totalDurationS, 0);
  assert.equal(result.userId, 'owner');
});
