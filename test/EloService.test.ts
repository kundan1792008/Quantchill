import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EloService,
  GLICKO_DEFAULT_RATING,
  GLICKO_DEFAULT_RD,
  GLICKO_DEFAULT_VOLATILITY,
  GLICKO_RATING_FLOOR,
  applyRatingFloor,
  computeNewVolatility,
  expectedScoreGlicko,
  fromMu,
  fromPhi,
  g,
  getDynamicKFactor,
  InMemoryGlickoStore,
  toMu,
  toPhi,
  updateRating
} from '../src/services/EloService';

// ─── Pure function tests ─────────────────────────────────────────────────────

test('Glicko: scale conversions are inverses', () => {
  const r = 1800;
  assert.ok(Math.abs(fromMu(toMu(r)) - r) < 1e-9);
  const rd = 200;
  assert.ok(Math.abs(fromPhi(toPhi(rd)) - rd) < 1e-9);
});

test('Glicko: g(φ) decreases as φ grows', () => {
  assert.ok(g(0.1) > g(1.0));
  assert.ok(g(1.0) > g(3.0));
});

test('Glicko: expectedScoreGlicko is 0.5 when µ equals µJ', () => {
  assert.equal(expectedScoreGlicko(0, 0, 1), 0.5);
});

test('Glicko: expectedScoreGlicko favours the higher µ', () => {
  assert.ok(expectedScoreGlicko(1, 0, 1) > 0.5);
  assert.ok(expectedScoreGlicko(-1, 0, 1) < 0.5);
});

test('Glicko: applyRatingFloor clamps at 800', () => {
  assert.equal(applyRatingFloor(500), GLICKO_RATING_FLOOR);
  assert.equal(applyRatingFloor(900), 900);
});

test('Glicko: computeNewVolatility stays close to σ when outcome is neutral', () => {
  const sigma = 0.06;
  const next = computeNewVolatility(1.2, sigma, 1.7, 0);
  assert.ok(next > 0 && next < 0.1);
});

test('Glicko: Glickman paper example produces expected µ′ ≈ -0.2069', () => {
  // Player (r=1500, RD=200, σ=0.06) vs 3 opponents: (1400, 30), (1550, 100), (1700, 300)
  // with outcomes 1, 0, 0. Expected new rating ~1464.06 (Glickman 2013, §Example).
  const rec = updateRating(
    {
      userId: 'P',
      rating: 1500,
      ratingDeviation: 200,
      volatility: 0.06,
      interactionCount: 0,
      lastUpdatedAt: 0
    },
    [
      { opponentRating: 1400, opponentRatingDeviation: 30, score: 1 },
      { opponentRating: 1550, opponentRatingDeviation: 100, score: 0 },
      { opponentRating: 1700, opponentRatingDeviation: 300, score: 0 }
    ]
  );
  assert.ok(Math.abs(rec.rating - 1464.06) < 0.5, `rating was ${rec.rating}`);
  assert.ok(rec.ratingDeviation < 200, 'RD should shrink after observations');
});

test('Glicko: no outcomes grows RD toward default 350', () => {
  const rec = updateRating(
    {
      userId: 'P',
      rating: 1500,
      ratingDeviation: 100,
      volatility: 0.06,
      interactionCount: 5,
      lastUpdatedAt: 0
    },
    []
  );
  assert.ok(rec.ratingDeviation > 100);
  assert.ok(rec.ratingDeviation <= GLICKO_DEFAULT_RD);
});

test('Glicko: getDynamicKFactor tiers', () => {
  assert.equal(getDynamicKFactor(0), 40);
  assert.equal(getDynamicKFactor(50), 20);
  assert.equal(getDynamicKFactor(500), 10);
});

// ─── EloService class tests ──────────────────────────────────────────────────

test('EloService seeds new users with default triplet', () => {
  const svc = new EloService();
  const r = svc.getRecord('u1');
  assert.equal(r.rating, GLICKO_DEFAULT_RATING);
  assert.equal(r.ratingDeviation, GLICKO_DEFAULT_RD);
  assert.equal(r.volatility, GLICKO_DEFAULT_VOLATILITY);
  assert.equal(r.interactionCount, 0);
});

test('EloService headToHead moves both ratings', () => {
  const svc = new EloService();
  const before = svc.getRecord('A');
  const { a, b } = svc.headToHead('A', 'B', 1);
  assert.ok(a.after.rating > before.rating, 'winner rating should increase');
  assert.ok(b.after.rating < GLICKO_DEFAULT_RATING, 'loser rating should decrease');
});

test('EloService enforces the 800 rating floor even after many losses', () => {
  const svc = new EloService();
  // Seed a very low-rated player and smash them with wins to see the floor.
  svc.seed({
    userId: 'weak',
    rating: 810,
    ratingDeviation: 50,
    volatility: 0.06,
    interactionCount: 200,
    lastUpdatedAt: 0
  });
  for (let i = 0; i < 50; i += 1) {
    svc.update('weak', [
      { opponentRating: 2400, opponentRatingDeviation: 30, score: 0 }
    ]);
  }
  const rec = svc.getRecord('weak');
  assert.ok(rec.rating >= GLICKO_RATING_FLOOR, `rating fell below floor: ${rec.rating}`);
});

test('EloService processBatch drains up to maxUpdates', () => {
  const svc = new EloService();
  for (let i = 0; i < 10; i += 1) {
    svc.enqueueBatch({
      userId: `u${i}`,
      outcomes: [{ opponentRating: 1500, opponentRatingDeviation: 100, score: 1 }]
    });
  }
  const results = svc.processBatch(5);
  assert.equal(results.length, 5);
  assert.equal(svc.getQueueLength(), 5);
});

test('EloService processBatch sustains 1000 updates in a single call', () => {
  const svc = new EloService();
  for (let i = 0; i < 1000; i += 1) {
    svc.enqueueBatch({
      userId: `u${i}`,
      outcomes: [{ opponentRating: 1500, opponentRatingDeviation: 100, score: i % 2 }]
    });
  }
  const start = Date.now();
  const results = svc.processBatch(1000);
  const elapsed = Date.now() - start;
  assert.equal(results.length, 1000);
  assert.ok(elapsed < 1000, `1000 updates took ${elapsed} ms`);
});

test('EloService InMemoryGlickoStore stores defensive copies', () => {
  const store = new InMemoryGlickoStore();
  const rec = {
    userId: 'x',
    rating: 1500,
    ratingDeviation: 350,
    volatility: 0.06,
    interactionCount: 0,
    lastUpdatedAt: 0
  };
  store.set(rec);
  rec.rating = 9999;
  const fetched = store.get('x');
  assert.equal(fetched?.rating, 1500);
});
