import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GlickoEngine,
  DEFAULT_RATING,
  DEFAULT_RATING_DEVIATION,
  DEFAULT_VOLATILITY,
  RATING_FLOOR,
  applyRatingFloor,
  convertToGlicko2Scale,
  convertFromGlicko2Scale,
  g,
  E,
  expectedScore,
  getDynamicKFactor
} from '../src/services/GlickoEngine';

test('GlickoEngine initialises new players with canonical defaults', () => {
  const engine = new GlickoEngine();
  const player = engine.getPlayer('alice');
  assert.equal(player.rating, DEFAULT_RATING);
  assert.equal(player.ratingDeviation, DEFAULT_RATING_DEVIATION);
  assert.equal(player.volatility, DEFAULT_VOLATILITY);
  assert.equal(player.interactionCount, 0);
});

test('GlickoEngine matches Glickman (2013) worked example within ±0.1', () => {
  // From the Glicko-2 reference paper: player with rating 1500, RD 200, vol 0.06
  // plays three games vs opponents (1400/30), (1550/100), (1700/300) with
  // scores (1, 0, 0) and should end up ~≈ 1464 ± 1 rating, RD ≈ 151.5.
  const engine = new GlickoEngine();
  engine.seedPlayer({
    userId: 'subject',
    rating: 1500,
    ratingDeviation: 200,
    volatility: 0.06,
    interactionCount: 0,
    lastUpdatedAt: 0
  });

  const result = engine.update('subject', [
    { opponentRating: 1400, opponentRatingDeviation: 30, score: 1 },
    { opponentRating: 1550, opponentRatingDeviation: 100, score: 0 },
    { opponentRating: 1700, opponentRatingDeviation: 300, score: 0 }
  ]);

  assert.ok(Math.abs(result.after.rating - 1464.06) < 1.5, `rating was ${result.after.rating}`);
  assert.ok(Math.abs(result.after.ratingDeviation - 151.52) < 1.5, `RD was ${result.after.ratingDeviation}`);
  assert.equal(result.gamesProcessed, 3);
});

test('GlickoEngine applies rating floor when player loses heavily', () => {
  const engine = new GlickoEngine();
  engine.seedPlayer({
    userId: 'victim',
    rating: 820,
    ratingDeviation: 350,
    volatility: 0.06,
    interactionCount: 0,
    lastUpdatedAt: 0
  });
  // 30 games, all losses vs strong opponents.
  const matches = Array.from({ length: 30 }, () => ({
    opponentRating: 2000,
    opponentRatingDeviation: 30,
    score: 0 as const
  }));
  const res = engine.update('victim', matches);
  assert.ok(res.after.rating >= RATING_FLOOR, `expected ≥${RATING_FLOOR}, got ${res.after.rating}`);
});

test('GlickoEngine idle rating period increases RD but not rating', () => {
  const engine = new GlickoEngine();
  const seed = {
    userId: 'idle',
    rating: 1500,
    ratingDeviation: 100,
    volatility: 0.06,
    interactionCount: 0,
    lastUpdatedAt: 0
  };
  engine.seedPlayer(seed);
  const res = engine.update('idle', []);
  assert.equal(res.after.rating, 1500); // floor-safe identity
  assert.ok(res.after.ratingDeviation > 100);
  assert.ok(res.after.ratingDeviation <= DEFAULT_RATING_DEVIATION);
});

test('GlickoEngine.batchUpdate processes 1200 rating periods under 1 second', async () => {
  const engine = new GlickoEngine();
  const work = Array.from({ length: 1200 }, (_, i) => ({
    userId: `u${i}`,
    matches: [{ opponentRating: 1500, opponentRatingDeviation: 50, score: 1 as const }]
  }));
  const start = Date.now();
  const results = await engine.batchUpdate(work);
  const durationMs = Date.now() - start;
  assert.equal(results.length, 1200);
  assert.ok(durationMs < 1000, `batch took ${durationMs}ms`);
});

test('GlickoEngine.recordHeadToHead produces symmetric interaction counts', () => {
  const engine = new GlickoEngine();
  const { a, b } = engine.recordHeadToHead('a', 'b', 1);
  assert.equal(a.after.interactionCount, 1);
  assert.equal(b.after.interactionCount, 1);
  assert.ok(a.after.rating > a.before.rating, 'winner gains rating');
  assert.ok(b.after.rating < b.before.rating, 'loser loses rating');
});

test('getDynamicKFactor tiers are correct', () => {
  assert.equal(getDynamicKFactor(0), 40);
  assert.equal(getDynamicKFactor(29), 40);
  assert.equal(getDynamicKFactor(30), 20);
  assert.equal(getDynamicKFactor(99), 20);
  assert.equal(getDynamicKFactor(100), 10);
  assert.equal(getDynamicKFactor(1_000_000), 10);
});

test('expectedScore is symmetric and sums to 1', () => {
  const pA = expectedScore(1600, 1400);
  const pB = expectedScore(1400, 1600);
  assert.ok(Math.abs(pA + pB - 1) < 1e-9);
  assert.ok(pA > pB);
});

test('Glicko-2 scale helpers round-trip rating and RD', () => {
  const { mu, phi } = convertToGlicko2Scale(1725, 200);
  const { rating, ratingDeviation } = convertFromGlicko2Scale(mu, phi);
  assert.ok(Math.abs(rating - 1725) < 1e-6);
  assert.ok(Math.abs(ratingDeviation - 200) < 1e-6);
});

test('g() and E() match reference values', () => {
  const { phi: phi1 } = convertToGlicko2Scale(1400, 30);
  assert.ok(Math.abs(g(phi1) - 0.9955) < 0.01, `g=${g(phi1)}`);
  // E(µ=0, µJ=-0.5756, φJ=0.1727) ≈ 0.639
  const eVal = E(0, (1400 - 1500) / 173.7178, 30 / 173.7178);
  assert.ok(Math.abs(eVal - 0.639) < 0.01, `E=${eVal}`);
});

test('applyRatingFloor never lowers a rating above the floor', () => {
  assert.equal(applyRatingFloor(900), 900);
  assert.equal(applyRatingFloor(500), RATING_FLOOR);
  assert.equal(applyRatingFloor(500, 600), 600);
});

test('GlickoEngine reset empties the player store', () => {
  const engine = new GlickoEngine();
  engine.getPlayer('a');
  engine.getPlayer('b');
  assert.equal(engine.size(), 2);
  engine.reset();
  assert.equal(engine.size(), 0);
});
