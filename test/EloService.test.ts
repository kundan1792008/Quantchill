import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EloService,
  gPhi,
  expectedScore,
  toGlicko2Scale,
  fromGlicko2Scale,
  computeVariance,
  computeDelta,
  computeNewVolatility,
  computePrePeriodPhi,
  getGlicko2Bracket,
  getDynamicKFactor
} from '../src/services/EloService';

// ─── Pure function tests ──────────────────────────────────────────────────────

test('gPhi returns 1 when phi = 0', () => {
  assert.ok(Math.abs(gPhi(0) - 1) < 1e-10);
});

test('gPhi returns a value in (0, 1] for positive phi', () => {
  const result = gPhi(1.5);
  assert.ok(result > 0 && result <= 1, `Expected (0,1], got ${result}`);
});

test('expectedScore returns 0.5 when ratings are equal and phiJ = 0', () => {
  const e = expectedScore(0, 0, 0);
  assert.ok(Math.abs(e - 0.5) < 1e-10, `Expected 0.5, got ${e}`);
});

test('expectedScore favours higher-rated player', () => {
  const e = expectedScore(0.5, 0, 0);
  assert.ok(e > 0.5, `Expected >0.5, got ${e}`);
});

test('toGlicko2Scale converts default rating correctly', () => {
  const { mu } = toGlicko2Scale(1500, 350);
  assert.ok(Math.abs(mu) < 1e-10, `mu should be 0 for rating 1500, got ${mu}`);
});

test('fromGlicko2Scale is the inverse of toGlicko2Scale', () => {
  const original = { rating: 1200, rd: 200 };
  const { mu, phi } = toGlicko2Scale(original.rating, original.rd);
  const { rating, rd } = fromGlicko2Scale(mu, phi);
  assert.ok(Math.abs(rating - original.rating) < 0.01, `rating mismatch: ${rating}`);
  assert.ok(Math.abs(rd - original.rd) < 0.01, `rd mismatch: ${rd}`);
});

test('computeVariance returns Infinity when no opponents', () => {
  assert.equal(computeVariance(0, []), Infinity);
});

test('computeVariance returns a positive finite value for real opponents', () => {
  const { mu, phi } = toGlicko2Scale(1400, 30);
  const opponents = [toGlicko2Scale(1500, 100), toGlicko2Scale(1550, 100)];
  const v = computeVariance(mu, opponents);
  assert.ok(v > 0 && isFinite(v), `Expected finite positive, got ${v}`);
});

test('computeDelta is negative for an underperforming player', () => {
  const { mu, phi } = toGlicko2Scale(1000, 200);
  const opponents = [toGlicko2Scale(1500, 30)];
  const scores = [0];
  const v = computeVariance(mu, opponents);
  const delta = computeDelta(mu, v, opponents, scores);
  assert.ok(delta < 0, `Expected negative delta, got ${delta}`);
  void phi; // suppress unused warning
});

test('computeNewVolatility returns a positive value', () => {
  const { mu, phi } = toGlicko2Scale(1500, 200);
  const opponents = [toGlicko2Scale(1400, 30)];
  const scores = [1];
  const v = computeVariance(mu, opponents);
  const delta = computeDelta(mu, v, opponents, scores);
  const newSigma = computeNewVolatility(phi, 0.06, delta, v);
  assert.ok(newSigma > 0, `Expected positive volatility, got ${newSigma}`);
  void mu;
});

test('computePrePeriodPhi increases uncertainty', () => {
  const phi = 0.5;
  const sigma = 0.06;
  const phiStar = computePrePeriodPhi(phi, sigma);
  assert.ok(phiStar > phi, `Expected phi* > phi, got ${phiStar}`);
});

test('getGlicko2Bracket maps ratings to correct brackets', () => {
  assert.equal(getGlicko2Bracket(800), 'bronze');
  assert.equal(getGlicko2Bracket(1000), 'silver');
  assert.equal(getGlicko2Bracket(1200), 'gold');
  assert.equal(getGlicko2Bracket(1400), 'platinum');
  assert.equal(getGlicko2Bracket(1600), 'diamond');
});

test('getDynamicKFactor returns 40 for provisional players', () => {
  assert.equal(getDynamicKFactor(0), 40);
  assert.equal(getDynamicKFactor(29), 40);
});

test('getDynamicKFactor returns 10 for established players', () => {
  assert.equal(getDynamicKFactor(100), 10);
});

// ─── EloService class tests ───────────────────────────────────────────────────

test('EloService initialises new users with default 1000 rating', () => {
  const svc = new EloService();
  assert.equal(svc.getRating('u1'), 1000);
});

test('EloService getRecord returns default RD and volatility', () => {
  const svc = new EloService();
  const rec = svc.getRecord('u1');
  assert.equal(rec.ratingDeviation, 350);
  assert.equal(rec.volatility, 0.06);
});

test('EloService processGameResults win increases rating', () => {
  const svc = new EloService();
  svc.seedRecord({ userId: 'opp', rating: 1000, ratingDeviation: 200, volatility: 0.06, interactionCount: 0 });
  const before = svc.getRating('player');
  const result = svc.processGameResults('player', [{ opponentId: 'opp', score: 1 }]);
  assert.ok(result.newRating > before, `Rating should increase on win: ${before} → ${result.newRating}`);
});

test('EloService processGameResults loss decreases rating', () => {
  const svc = new EloService();
  svc.seedRecord({ userId: 'opp', rating: 1000, ratingDeviation: 200, volatility: 0.06, interactionCount: 0 });
  const before = svc.getRating('player');
  const result = svc.processGameResults('player', [{ opponentId: 'opp', score: 0 }]);
  assert.ok(result.newRating < before, `Rating should decrease on loss: ${before} → ${result.newRating}`);
});

test('EloService processGameResults no games only updates RD', () => {
  const svc = new EloService();
  const before = svc.getRecord('idle').rating;
  const result = svc.processGameResults('idle', []);
  assert.equal(result.newRating, before); // rating unchanged
  assert.ok(result.newRatingDeviation > 350, 'RD should grow during inactivity');
});

test('EloService rating floor prevents going below 800', () => {
  const svc = new EloService();
  // Seed a very weak player with a huge RD so one loss barely matters, but
  // to test the floor we seed a rating at 801 and force a big loss.
  svc.seedRecord({ userId: 'weak', rating: 801, ratingDeviation: 350, volatility: 0.06, interactionCount: 0 });
  svc.seedRecord({ userId: 'strong', rating: 2000, ratingDeviation: 30, volatility: 0.06, interactionCount: 0 });
  // Run many rounds until rating would drop below floor.
  for (let i = 0; i < 20; i++) {
    svc.processGameResults('weak', [{ opponentId: 'strong', score: 0 }]);
  }
  assert.ok(svc.getRating('weak') >= 800, `Rating floor violated: ${svc.getRating('weak')}`);
});

test('EloService processSwipe like raises both ratings', () => {
  const svc = new EloService();
  const beforeViewer = svc.getRating('viewer');
  const beforeSubject = svc.getRating('subject');
  const { viewerResult, subjectResult } = svc.processSwipe('viewer', 'subject', 'like');
  assert.ok(viewerResult.newRating > beforeViewer);
  assert.ok(subjectResult.newRating > beforeSubject);
});

test('EloService processSwipe skip lowers subject rating', () => {
  const svc = new EloService();
  const beforeSubject = svc.getRating('subject');
  const { subjectResult } = svc.processSwipe('viewer', 'subject', 'skip');
  assert.ok(subjectResult.newRating < beforeSubject);
});

test('EloService seedRecord and getAllRecords', () => {
  const svc = new EloService();
  svc.seedRecord({ userId: 'a', rating: 1200, ratingDeviation: 100, volatility: 0.05, interactionCount: 50 });
  svc.seedRecord({ userId: 'b', rating: 1400, ratingDeviation: 80, volatility: 0.04, interactionCount: 120 });
  const all = svc.getAllRecords();
  assert.equal(all.length, 2);
  assert.ok(all.some((r) => r.userId === 'a' && r.rating === 1200));
});

test('EloService getBracket returns correct bracket label', () => {
  const svc = new EloService();
  svc.seedRecord({ userId: 'gold', rating: 1250, ratingDeviation: 100, volatility: 0.06, interactionCount: 0 });
  assert.equal(svc.getBracket('gold'), 'gold');
});
