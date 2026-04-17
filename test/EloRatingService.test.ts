import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EloRatingService,
  getDynamicKFactor,
  expectedScore,
  computeNewRating,
  getEloBracket,
  sameBracket
} from '../src/services/EloRatingService';

// ─── Pure function tests ──────────────────────────────────────────────────────

test('getDynamicKFactor returns 40 for provisional players (< 30 interactions)', () => {
  assert.equal(getDynamicKFactor(0), 40);
  assert.equal(getDynamicKFactor(29), 40);
});

test('getDynamicKFactor returns 20 for intermediate players (30–99 interactions)', () => {
  assert.equal(getDynamicKFactor(30), 20);
  assert.equal(getDynamicKFactor(99), 20);
});

test('getDynamicKFactor returns 10 for established players (≥ 100 interactions)', () => {
  assert.equal(getDynamicKFactor(100), 10);
  assert.equal(getDynamicKFactor(5000), 10);
});

test('expectedScore returns 0.5 when both ratings are equal', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
});

test('expectedScore favours the higher-rated player', () => {
  const e = expectedScore(1200, 1000);
  assert.ok(e > 0.5, `Expected >0.5 but got ${e}`);
});

test('computeNewRating increases rating on win', () => {
  const rating = computeNewRating(1000, 40, 1, 0.5);
  assert.ok(rating > 1000, `Expected >1000 but got ${rating}`);
});

test('computeNewRating decreases rating on loss', () => {
  const rating = computeNewRating(1000, 40, 0, 0.5);
  assert.ok(rating < 1000, `Expected <1000 but got ${rating}`);
});

test('getEloBracket maps ratings to correct brackets', () => {
  assert.equal(getEloBracket(800), 'bronze');
  assert.equal(getEloBracket(1000), 'silver');
  assert.equal(getEloBracket(1200), 'gold');
  assert.equal(getEloBracket(1400), 'platinum');
  assert.equal(getEloBracket(1600), 'diamond');
});

test('sameBracket returns true for two players in the same bracket', () => {
  assert.equal(sameBracket(1000, 1050), true);
});

test('sameBracket returns false for players in different brackets', () => {
  assert.equal(sameBracket(999, 1000), false);
});

// ─── EloRatingService class tests ────────────────────────────────────────────

test('EloRatingService initialises new users with default 1000 ELO', () => {
  const svc = new EloRatingService();
  assert.equal(svc.getRating('u1'), 1000);
});

test('EloRatingService processSwipe "skip" reduces subject rating', () => {
  const svc = new EloRatingService();
  const before = svc.getRating('subject');
  svc.processSwipe('viewer', 'subject', 'skip');
  const after = svc.getRating('subject');
  assert.ok(after < before, `Subject rating should decrease on skip: ${before} → ${after}`);
});

test('EloRatingService processSwipe "hold" increases subject rating', () => {
  const svc = new EloRatingService();
  const before = svc.getRating('subject');
  svc.processSwipe('viewer', 'subject', 'hold');
  const after = svc.getRating('subject');
  assert.ok(after > before, `Subject rating should increase on hold: ${before} → ${after}`);
});

test('EloRatingService processSwipe increments interaction count for both parties', () => {
  const svc = new EloRatingService();
  svc.processSwipe('viewer', 'subject', 'skip');
  assert.equal(svc.getRecord('viewer').interactionCount, 1);
  assert.equal(svc.getRecord('subject').interactionCount, 1);
});

test('EloRatingService K-factor decreases for established players', () => {
  const svc = new EloRatingService();

  // Seed the viewer with 100 interactions so they are "established".
  svc.seedRecord({ userId: 'veteran', rating: 1000, interactionCount: 100 });
  const result = svc.processSwipe('newbie', 'veteran', 'skip');

  // Both start at 1000 so expected score = 0.5 for both.
  // On 'skip': subject S=0, viewer S=0.5 (draw).
  // Veteran (established, K=10): delta = 10 * (0 - 0.5) = -5 → 995
  // Newbie  (provisional,  K=40): delta = 40 * (0.5 - 0.5) = 0 → 1000
  assert.equal(result.subjectElo.rating, 995);
  assert.equal(result.viewerElo.rating, 1000);
});

test('EloRatingService getBracket returns correct bracket label', () => {
  const svc = new EloRatingService();
  svc.seedRecord({ userId: 'goldUser', rating: 1250, interactionCount: 0 });
  assert.equal(svc.getBracket('goldUser'), 'gold');
});

test('EloRatingService getAllRecords returns snapshot of all stored users', () => {
  const svc = new EloRatingService();
  svc.getRecord('a');
  svc.getRecord('b');
  const all = svc.getAllRecords();
  assert.equal(all.length, 2);
  assert.ok(all.every((r) => r.rating === 1000));
});
