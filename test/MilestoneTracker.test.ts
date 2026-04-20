import test from 'node:test';
import assert from 'node:assert/strict';
import { MilestoneTracker } from '../src/services/MilestoneTracker';

test('MilestoneTracker starts with starter milestone progress', () => {
  const tracker = new MilestoneTracker();
  const startedAt = 1_700_000_000_000;

  const state = tracker.update({
    conversationId: 'c-1',
    participants: ['u1', 'u2'],
    startedAtMs: startedAt,
    nowMs: startedAt + 3 * 60_000,
    messageCount: 8,
    averageWordsPerMessage: 8,
    compatibilityScore: 40
  });

  assert.equal(state.activeTier, 'starter');
  assert.equal(state.progress.tier, 'starter');
  assert.equal(state.progress.nextTier, 'connected');
  assert.ok(state.progress.progressPct > 0);
});

test('MilestoneTracker advances to resonant for sustained high-compatibility chats', () => {
  const tracker = new MilestoneTracker();
  const startedAt = 1_700_000_000_000;

  const state = tracker.update({
    conversationId: 'c-2',
    participants: ['u3', 'u4'],
    startedAtMs: startedAt,
    nowMs: startedAt + 18 * 60_000,
    messageCount: 42,
    averageWordsPerMessage: 14,
    compatibilityScore: 78
  });

  assert.equal(state.activeTier, 'resonant');
  assert.ok(state.achievedTiers.includes('starter'));
  assert.ok(state.achievedTiers.includes('connected'));
  assert.ok(state.achievedTiers.includes('resonant'));
  assert.equal(state.progress.rewardLabel, 'Resonance Flow');
});

test('MilestoneTracker caps at deep-link and exposes a full progress indicator', () => {
  const tracker = new MilestoneTracker();
  const startedAt = 1_700_000_000_000;

  const state = tracker.update({
    conversationId: 'c-3',
    participants: ['u5', 'u6'],
    startedAtMs: startedAt,
    nowMs: startedAt + 35 * 60_000,
    messageCount: 70,
    averageWordsPerMessage: 16,
    compatibilityScore: 90
  });

  assert.equal(state.activeTier, 'deep-link');
  assert.equal(state.progress.progressPct, 100);
  assert.equal(state.progress.nextTier, null);

  const saved = tracker.get('c-3');
  assert.ok(saved);
  assert.equal(saved!.activeTier, 'deep-link');
});
