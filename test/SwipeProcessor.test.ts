import test from 'node:test';
import assert from 'node:assert/strict';
import { SwipeProcessor } from '../src/services/SwipeProcessor';
import { EloService } from '../src/services/EloService';

function makeProcessor(): SwipeProcessor {
  return new SwipeProcessor(new EloService());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('SwipeProcessor like updates ELO for both parties', () => {
  const p = makeProcessor();
  const result = p.process({
    userId: 'alice',
    targetId: 'bob',
    action: 'like',
    dwellTimeMs: 500,
    scrollVelocity: 200
  });
  assert.equal(result.userId, 'alice');
  assert.equal(result.action, 'like');
  assert.ok(result.userRating > 0);
  assert.ok(result.targetRating > 0);
  assert.equal(result.cooldownApplied, false);
});

test('SwipeProcessor dwell > 3000 ms adds +2 compatibility', () => {
  const p = makeProcessor();
  const result = p.process({
    userId: 'alice',
    targetId: 'bob',
    action: 'like',
    dwellTimeMs: 4000,
    scrollVelocity: 200
  });
  assert.ok(result.compatibilityDelta >= 2, `Expected >=2, got ${result.compatibilityDelta}`);
});

test('SwipeProcessor scroll < 100 px/s adds +1 compatibility', () => {
  const p = makeProcessor();
  const result = p.process({
    userId: 'alice',
    targetId: 'bob',
    action: 'like',
    dwellTimeMs: 100,
    scrollVelocity: 50
  });
  assert.ok(result.compatibilityDelta >= 1, `Expected >=1, got ${result.compatibilityDelta}`);
});

test('SwipeProcessor both signals give +3 compatibility', () => {
  const p = makeProcessor();
  const result = p.process({
    userId: 'alice',
    targetId: 'bob',
    action: 'like',
    dwellTimeMs: 5000,
    scrollVelocity: 30
  });
  assert.equal(result.compatibilityDelta, 3);
});

test('SwipeProcessor no signals gives 0 compatibility delta', () => {
  const p = makeProcessor();
  const result = p.process({
    userId: 'alice',
    targetId: 'bob',
    action: 'skip',
    dwellTimeMs: 100,
    scrollVelocity: 200
  });
  assert.equal(result.compatibilityDelta, 0);
});

test('SwipeProcessor 6 rapid skips trigger cooldown', () => {
  const p = makeProcessor();
  let lastResult;
  for (let i = 0; i < 7; i++) {
    lastResult = p.process({
      userId: 'spammer',
      targetId: `target${i}`,
      action: 'skip',
      dwellTimeMs: 100,
      scrollVelocity: 300
    });
  }
  assert.equal(lastResult?.cooldownApplied, true);
  assert.equal(p.isInCooldown('spammer'), true);
});

test('SwipeProcessor cooldown prevents ELO update', () => {
  const p = makeProcessor();
  // Trigger cooldown by spamming skips.
  for (let i = 0; i < 7; i++) {
    p.process({ userId: 'spammer', targetId: `t${i}`, action: 'skip', dwellTimeMs: 100, scrollVelocity: 300 });
  }
  assert.equal(p.isInCooldown('spammer'), true);
  const eloService = (p as unknown as { eloService: EloService }).eloService;
  const ratingBefore = eloService.getRating('spammer');
  p.process({ userId: 'spammer', targetId: 'newTarget', action: 'like', dwellTimeMs: 100, scrollVelocity: 200 });
  // Rating should be unchanged because of cooldown.
  assert.equal(eloService.getRating('spammer'), ratingBefore);
});

test('SwipeProcessor cooldownExpiry returns null when not in cooldown', () => {
  const p = makeProcessor();
  assert.equal(p.cooldownExpiry('fresh'), null);
});

test('SwipeProcessor cooldownExpiry returns future timestamp during cooldown', () => {
  const p = makeProcessor();
  for (let i = 0; i < 7; i++) {
    p.process({ userId: 'u', targetId: `t${i}`, action: 'skip', dwellTimeMs: 100, scrollVelocity: 300 });
  }
  const expiry = p.cooldownExpiry('u');
  assert.ok(expiry !== null && expiry > Date.now(), `Expected future expiry, got ${expiry}`);
});
