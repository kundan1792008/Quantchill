import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, FREE_TIER_LIMIT_SECONDS } from '../src/services/SessionTracker';

test('SessionTracker creates a session with correct initial state', () => {
  const tracker = new SessionTracker();
  const state = tracker.createSession({
    sessionId: 'sess-1',
    userId: 'user-1',
    mood: 'Deep Focus',
    isPremium: false
  });

  assert.equal(state.sessionId, 'sess-1');
  assert.equal(state.userId, 'user-1');
  assert.equal(state.mood, 'Deep Focus');
  assert.equal(state.sessionTime, 0);
  assert.equal(state.isPremium, false);
  assert.equal(state.paywallShown, false);
  assert.equal(state.quantchatSynced, false);
});

test('SessionTracker tick accumulates sessionTime', () => {
  const tracker = new SessionTracker();
  tracker.createSession({ sessionId: 's1', userId: 'u1', mood: 'Hype Workout', isPremium: false });

  tracker.tick('s1', 600);
  tracker.tick('s1', 600);

  const state = tracker.getSession('s1');
  assert.equal(state?.sessionTime, 1200);
});

test('SessionTracker tick triggers paywall after 60 minutes for free user', () => {
  const tracker = new SessionTracker();
  tracker.createSession({ sessionId: 's2', userId: 'u2', mood: 'Cyberpunk Rain', isPremium: false });

  // Advance just under the limit
  const noTrigger = tracker.tick('s2', FREE_TIER_LIMIT_SECONDS - 1);
  assert.equal(noTrigger, null);

  // One more second should trigger the paywall
  const trigger = tracker.tick('s2', 1);
  assert.ok(trigger !== null);
  assert.equal(trigger!.triggered, true);
  assert.equal(trigger!.offerMonthlyPrice, 12);
  assert.ok(trigger!.message.includes('Quantchill Premium'));
});

test('SessionTracker paywall is shown only once per session', () => {
  const tracker = new SessionTracker();
  tracker.createSession({ sessionId: 's3', userId: 'u3', mood: 'Ethereal Sleep', isPremium: false });

  tracker.tick('s3', FREE_TIER_LIMIT_SECONDS + 100);
  const second = tracker.tick('s3', 100);
  assert.equal(second, null);
});

test('SessionTracker does NOT trigger paywall for premium user', () => {
  const tracker = new SessionTracker();
  tracker.createSession({ sessionId: 's4', userId: 'u4', mood: 'Deep Focus', isPremium: true });

  const result = tracker.tick('s4', FREE_TIER_LIMIT_SECONDS + 1000);
  assert.equal(result, null);
});

test('SessionTracker syncWithQuantchat returns valid sync result', () => {
  const tracker = new SessionTracker();
  tracker.createSession({ sessionId: 's5', userId: 'u5', mood: 'Cyberpunk Rain', isPremium: false });

  const sync = tracker.syncWithQuantchat('s5');
  assert.ok(sync.partyId.startsWith('party-'));
  assert.equal(sync.mood, 'Cyberpunk Rain');
  assert.ok(sync.inviteUrl.includes(sync.partyId));

  const state = tracker.getSession('s5');
  assert.equal(state?.quantchatSynced, true);
});

test('SessionTracker syncWithQuantchat throws for unknown session', () => {
  const tracker = new SessionTracker();
  assert.throws(() => tracker.syncWithQuantchat('no-such-session'), /not found/i);
});

test('SessionTracker endSession removes the session and returns final state', () => {
  const tracker = new SessionTracker();
  tracker.createSession({ sessionId: 's6', userId: 'u6', mood: 'Hype Workout', isPremium: false });
  tracker.tick('s6', 300);

  const final = tracker.endSession('s6');
  assert.equal(final?.sessionTime, 300);
  assert.equal(tracker.getSession('s6'), null);
});

test('SessionTracker tick returns null for unknown session', () => {
  const tracker = new SessionTracker();
  const result = tracker.tick('unknown', 10);
  assert.equal(result, null);
});
