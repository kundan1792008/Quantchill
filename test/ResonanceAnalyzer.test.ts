import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionEvent, ResonanceAnalyzer } from '../src/services/ResonanceAnalyzer';

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FIVE_HOURS_MS = 25 * ONE_HOUR_MS;

function makeEvent(overrides: Partial<InteractionEvent> = {}): InteractionEvent {
  return {
    userId: 'u1',
    peerId: 'u2',
    occurredAtMs: 1_700_000_000_000,
    timeSpentMs: 8 * 60_000,
    messageCount: 18,
    averageWordsPerMessage: 12,
    conversationTurns: 22,
    sustainedConversation: true,
    ...overrides
  };
}

test('ResonanceAnalyzer builds a non-empty personality matrix embedding', () => {
  const analyzer = new ResonanceAnalyzer(() => 1_700_000_000_000);
  const matrix = analyzer.buildPersonalityMatrix('u1', [
    makeEvent(),
    makeEvent({ timeSpentMs: 10 * 60_000, messageCount: 22, conversationTurns: 28 })
  ]);

  assert.equal(matrix.userId, 'u1');
  assert.equal(matrix.interactionCount24h, 2);
  assert.equal(matrix.embedding.length, 5);
  assert.ok(matrix.conversationDepth > 0);
  assert.ok(matrix.sustainedConversationRate > 0);
});

test('ResonanceAnalyzer enforces 24-hour rolling window updates', () => {
  const nowMs = 1_700_000_000_000;
  const analyzer = new ResonanceAnalyzer(() => nowMs);

  const stale = makeEvent({ occurredAtMs: nowMs - TWENTY_FIVE_HOURS_MS });
  const fresh = makeEvent({ occurredAtMs: nowMs - (2 * ONE_HOUR_MS) });

  const inWindow = analyzer.filterToRollingWindow([stale, fresh]);
  assert.equal(inWindow.length, 1);
  assert.equal(inWindow[0]?.occurredAtMs, fresh.occurredAtMs);
});

test('ResonanceAnalyzer compatibility graph prefers behaviorally similar users', () => {
  const nowMs = 1_700_000_000_000;
  const analyzer = new ResonanceAnalyzer(() => nowMs);

  const events: InteractionEvent[] = [
    makeEvent({ userId: 'u1', peerId: 'u2' }),
    makeEvent({ userId: 'u2', peerId: 'u1', timeSpentMs: 9 * 60_000, messageCount: 20, conversationTurns: 24 }),
    makeEvent({ userId: 'u1', peerId: 'u3', timeSpentMs: 2 * 60_000, messageCount: 3, averageWordsPerMessage: 3, conversationTurns: 4, sustainedConversation: false }),
    makeEvent({ userId: 'u3', peerId: 'u1', timeSpentMs: 2 * 60_000, messageCount: 4, averageWordsPerMessage: 2, conversationTurns: 5, sustainedConversation: false })
  ];

  const graph = analyzer.updateRollingGraph(['u1', 'u2', 'u3'], events);
  const u1u2 = graph.edges.find((edge) => edge.sourceUserId === 'u1' && edge.targetUserId === 'u2');
  const u1u3 = graph.edges.find((edge) => edge.sourceUserId === 'u1' && edge.targetUserId === 'u3');

  assert.ok(u1u2);
  assert.ok(u1u3);
  assert.ok(u1u2!.score > u1u3!.score);
});
