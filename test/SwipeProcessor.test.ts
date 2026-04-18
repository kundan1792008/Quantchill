import test from 'node:test';
import assert from 'node:assert/strict';
import { EloService } from '../src/services/EloService';
import { SwipeProcessor } from '../src/services/SwipeProcessor';

function buildProcessor(opts?: { now?: () => number }) {
  const elo = new EloService();
  const sp = new SwipeProcessor(elo, {
    now: opts?.now,
    rapidSkipWindowMs: 10_000,
    rapidSkipThreshold: 5,
    cooldownMs: 30_000
  });
  return { elo, sp };
}

test('SwipeProcessor rejects self-swipe', () => {
  const { sp } = buildProcessor();
  assert.throws(() => sp.process({ userId: 'a', targetId: 'a', action: 'like', dwellTimeMs: 0, scrollVelocity: 0 }));
});

test('SwipeProcessor rejects unknown actions', () => {
  const { sp } = buildProcessor();
  assert.throws(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sp.process({ userId: 'a', targetId: 'b', action: 'poke' as any, dwellTimeMs: 10, scrollVelocity: 10 })
  );
});

test('SwipeProcessor awards +2 compatibility for dwell > 3000 ms', () => {
  const { sp } = buildProcessor();
  const r = sp.process({ userId: 'a', targetId: 'b', action: 'like', dwellTimeMs: 4000, scrollVelocity: 200 });
  assert.ok(r.reasons.includes('high-dwell'));
  assert.ok(r.compatibilityDelta >= 2);
});

test('SwipeProcessor awards +1 compatibility for scroll velocity < 100 px/s', () => {
  const { sp } = buildProcessor();
  const r = sp.process({ userId: 'a', targetId: 'b', action: 'like', dwellTimeMs: 500, scrollVelocity: 50 });
  assert.ok(r.reasons.includes('careful-browsing'));
  assert.ok(r.compatibilityDelta >= 1);
});

test('SwipeProcessor awards superlike bonus', () => {
  const { sp } = buildProcessor();
  const r = sp.process({ userId: 'a', targetId: 'b', action: 'superlike', dwellTimeMs: 0, scrollVelocity: 500 });
  assert.ok(r.reasons.includes('superlike'));
  assert.equal(r.compatibilityDelta, 5);
});

test('SwipeProcessor applies cooldown after 5 skips in 10 s', () => {
  let now = 0;
  const { sp } = buildProcessor({ now: () => now });
  for (let i = 0; i < 4; i += 1) {
    now += 1000;
    const r = sp.process({ userId: 'a', targetId: `t${i}`, action: 'skip', dwellTimeMs: 0, scrollVelocity: 500 });
    assert.equal(r.cooldownApplied, false);
  }
  now += 1000;
  const last = sp.process({ userId: 'a', targetId: 't5', action: 'skip', dwellTimeMs: 0, scrollVelocity: 500 });
  assert.equal(last.cooldownApplied, true);
  assert.ok(sp.isInCooldown('a'));
});

test('SwipeProcessor does NOT cool down when skips are spread over > 10 s', () => {
  let now = 0;
  const { sp } = buildProcessor({ now: () => now });
  for (let i = 0; i < 6; i += 1) {
    now += 3000;
    sp.process({ userId: 'a', targetId: `t${i}`, action: 'skip', dwellTimeMs: 0, scrollVelocity: 500 });
  }
  assert.equal(sp.isInCooldown('a'), false);
});

test('SwipeProcessor detects mutual matches across both directions', () => {
  const { sp } = buildProcessor();
  sp.process({ userId: 'a', targetId: 'b', action: 'like', dwellTimeMs: 100, scrollVelocity: 500 });
  const r = sp.process({ userId: 'b', targetId: 'a', action: 'like', dwellTimeMs: 100, scrollVelocity: 500 });
  assert.equal(r.mutualMatch, true);
  assert.deepEqual(sp.getMutualMatches('a'), ['b']);
});

test('SwipeProcessor updates Glicko ratings on each swipe', () => {
  const { elo, sp } = buildProcessor();
  sp.process({ userId: 'a', targetId: 'b', action: 'like', dwellTimeMs: 0, scrollVelocity: 500 });
  // 'like' means viewer "won" → rating goes up, target goes down.
  assert.ok(elo.getRecord('a').rating > 1500);
  assert.ok(elo.getRecord('b').rating < 1500);
});

test('SwipeProcessor prune drops stale traces', () => {
  let now = 0;
  const { sp } = buildProcessor({ now: () => now });
  sp.process({ userId: 'a', targetId: 'b', action: 'skip', dwellTimeMs: 0, scrollVelocity: 500 });
  now += 60_000;
  sp.prune();
  // After pruning, cooldown/skip-trace for 'a' should be gone.
  assert.equal(sp.isInCooldown('a'), false);
});
