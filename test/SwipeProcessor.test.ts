import test from 'node:test';
import assert from 'node:assert/strict';
import { GlickoEngine } from '../src/services/GlickoEngine';
import {
  SwipeProcessor,
  DEFAULT_SWIPE_CONFIG,
  type CompatibilitySignal
} from '../src/services/SwipeProcessor';

function makeProcessor(nowRef: { t: number }) {
  const glicko = new GlickoEngine();
  const processor = new SwipeProcessor(glicko, {}, () => nowRef.t);
  return { glicko, processor };
}

test('SwipeProcessor rewards likes with a positive compatibility delta', () => {
  const now = { t: 1000 };
  const { processor } = makeProcessor(now);
  const sig: CompatibilitySignal[] = [];
  processor.onCompatibility((s) => sig.push(s));

  const res = processor.process({
    userId: 'a',
    targetId: 'b',
    action: 'like',
    dwellTimeMs: 1500,
    scrollVelocity: 400
  });

  assert.equal(res.accepted, true);
  assert.equal(res.compatibility.delta, 3);
  assert.equal(res.compatibility.positive, true);
  assert.equal(sig.length, 1);
});

test('SwipeProcessor adds +2 for long dwell and +1 for slow scroll', () => {
  const now = { t: 0 };
  const { processor } = makeProcessor(now);
  const res = processor.process({
    userId: 'a',
    targetId: 'b',
    action: 'like',
    dwellTimeMs: DEFAULT_SWIPE_CONFIG.dwellThresholdMs + 1,
    scrollVelocity: DEFAULT_SWIPE_CONFIG.slowScrollThreshold - 1
  });
  assert.equal(res.compatibility.delta, 3 + 2 + 1);
  assert.ok(res.compatibility.reasons.includes('long-dwell'));
  assert.ok(res.compatibility.reasons.includes('careful-browsing'));
});

test('SwipeProcessor superlike produces a strong positive signal and top Glicko win', () => {
  const now = { t: 0 };
  const { processor, glicko } = makeProcessor(now);
  const before = glicko.getPlayer('a').rating;
  const res = processor.process({
    userId: 'a',
    targetId: 'b',
    action: 'superlike',
    dwellTimeMs: 100,
    scrollVelocity: 500
  });
  assert.equal(res.compatibility.delta, 5);
  assert.equal(res.compatibility.positive, true);
  // Since both players start at 1500, a superlike (S=1 for viewer) pushes viewer up.
  assert.ok(glicko.getPlayer('a').rating > before);
});

test('SwipeProcessor rapid-skip cooldown triggers after >5 skips in 10 seconds', () => {
  const now = { t: 0 };
  const { processor } = makeProcessor(now);
  for (let i = 0; i < 6; i += 1) {
    processor.process({
      userId: 'u',
      targetId: `t${i}`,
      action: 'skip',
      dwellTimeMs: 200,
      scrollVelocity: 900
    });
    now.t += 500;
  }
  assert.equal(processor.isInCooldown('u'), true);

  const rejected = processor.process({
    userId: 'u',
    targetId: 'tnext',
    action: 'skip',
    dwellTimeMs: 100,
    scrollVelocity: 500
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.rejection?.reason, 'rapid-skip-cooldown');
});

test('SwipeProcessor cooldown expires after rapidSkipPenaltyMs', () => {
  const now = { t: 0 };
  const { processor } = makeProcessor(now);
  for (let i = 0; i < 6; i += 1) {
    processor.process({ userId: 'u', targetId: `t${i}`, action: 'skip', dwellTimeMs: 0, scrollVelocity: 0 });
    now.t += 500;
  }
  assert.equal(processor.isInCooldown('u'), true);
  now.t += DEFAULT_SWIPE_CONFIG.rapidSkipPenaltyMs + 1;
  assert.equal(processor.isInCooldown('u'), false);
});

test('SwipeProcessor rejects self-swipes', () => {
  const { processor } = makeProcessor({ t: 0 });
  assert.throws(() =>
    processor.process({
      userId: 'a',
      targetId: 'a',
      action: 'like',
      dwellTimeMs: 0,
      scrollVelocity: 0
    })
  );
});

test('SwipeProcessor validates numeric inputs', () => {
  const { processor } = makeProcessor({ t: 0 });
  assert.throws(() =>
    processor.process({
      userId: 'a',
      targetId: 'b',
      action: 'like',
      dwellTimeMs: -1,
      scrollVelocity: 0
    })
  );
  assert.throws(() =>
    processor.process({
      userId: 'a',
      targetId: 'b',
      action: 'like',
      dwellTimeMs: 0,
      scrollVelocity: Number.NaN
    })
  );
});

test('SwipeProcessor clamps compatibility delta to ±10', () => {
  const { processor } = makeProcessor({ t: 0 });
  const res = processor.process({
    userId: 'a',
    targetId: 'b',
    action: 'superlike',
    dwellTimeMs: 99_999,
    scrollVelocity: 0
  });
  assert.ok(res.compatibility.delta <= 10);
});
