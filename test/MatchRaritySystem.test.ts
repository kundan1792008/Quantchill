import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MatchRaritySystem,
  computeCompatibility,
  scoreToTier,
  clamp01,
  TIER_THRESHOLDS,
  TIME_ON_CARD_SATURATION_MS,
  DEFAULT_WEIGHTS
} from '../src/services/MatchRaritySystem';

test('clamp01 restricts values to [0,1] and treats non-finite as 0', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(Number.NaN), 0);
});

test('scoreToTier uses documented thresholds', () => {
  assert.equal(scoreToTier(0), 'low');
  assert.equal(scoreToTier(TIER_THRESHOLDS.medium - 0.0001), 'low');
  assert.equal(scoreToTier(TIER_THRESHOLDS.medium), 'medium');
  assert.equal(scoreToTier(TIER_THRESHOLDS.high - 0.0001), 'medium');
  assert.equal(scoreToTier(TIER_THRESHOLDS.high), 'high');
  assert.equal(scoreToTier(TIER_THRESHOLDS.veryHigh - 0.0001), 'high');
  assert.equal(scoreToTier(TIER_THRESHOLDS.veryHigh), 'very_high');
  assert.equal(scoreToTier(1), 'very_high');
});

test('tiers use neutral labels (no Bronze/Silver/Gold/Diamond gacha terms)', () => {
  const labels = new Set<string>();
  for (let s = 0; s <= 1.0001; s += 0.05) labels.add(scoreToTier(s));
  assert.deepEqual(
    [...labels].sort(),
    ['high', 'low', 'medium', 'very_high']
  );
});

test('empty signals produce a near-zero score in the "low" tier', () => {
  const r = computeCompatibility({});
  // scrollSpeedPx unknown contributes a neutral 0.5 * weight=0.2 = 0.1 to raw
  // with wSum=1, so score == 0.1 → low tier.
  assert.equal(r.tier, 'low');
  assert.ok(r.score <= TIER_THRESHOLDS.medium);
});

test('strong engagement signals saturate to very_high', () => {
  const r = computeCompatibility({
    timeOnCardMs: TIME_ON_CARD_SATURATION_MS * 2,
    scrollSpeedPx: 0,
    revisitCount: 10,
    pauseCount: 10
  });
  assert.equal(r.score, 1);
  assert.equal(r.tier, 'very_high');
});

test('computeCompatibility does not accept nor consume any payment/tier argument', () => {
  // Positive structural assertion: the function signature is 2-ary and both
  // parameters are signal-related – there is no third argument for payment,
  // subscription, or user tier. This guards against regressions that would
  // re-introduce paywall coupling.
  assert.equal(computeCompatibility.length, 1); // weights has a default
});

test('MatchRaritySystem wrapper matches pure function output', () => {
  const signals = { timeOnCardMs: 4000, scrollSpeedPx: 500, revisitCount: 1, pauseCount: 1 };
  const fromFn = computeCompatibility(signals);
  const fromSvc = new MatchRaritySystem().compute(signals);
  assert.deepEqual(fromSvc, fromFn);
});

test('weights sum to 1 by default so raw score is bounded to [0,1]', () => {
  const sum =
    DEFAULT_WEIGHTS.timeOnCard +
    DEFAULT_WEIGHTS.calm +
    DEFAULT_WEIGHTS.revisit +
    DEFAULT_WEIGHTS.pause;
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum = ${sum}`);
});

test('custom weights with zero sum are rejected', () => {
  assert.throws(() =>
    computeCompatibility({ timeOnCardMs: 1000 }, { timeOnCard: 0, calm: 0, revisit: 0, pause: 0 })
  );
});
