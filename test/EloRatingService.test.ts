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

test('expectedScore returns 0.5 for equal ratings', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
});

test('expectedScore is higher for the stronger player', () => {
  assert.ok(expectedScore(1200, 1000) > 0.5);
  assert.ok(expectedScore(800, 1000) < 0.5);
});

test('computeNewRating increases rating on win', () => {
  const newRating = computeNewRating(1000, 20, 1, 0.5);
  assert.equal(newRating, 1010);
});

test('computeNewRating decreases rating on loss', () => {
  const newRating = computeNewRating(1000, 20, 0, 0.5);
  assert.equal(newRating, 990);
});

test('computeNewRating is unchanged for expected draw outcome', () => {
  const newRating = computeNewRating(1000, 20, 0.5, 0.5);
  assert.equal(newRating, 1000);
});

test('getEloBracket returns correct brackets', () => {
  assert.equal(getEloBracket(999), 'bronze');
  assert.equal(getEloBracket(1000), 'silver');
  assert.equal(getEloBracket(1200), 'gold');
  assert.equal(getEloBracket(1400), 'platinum');
  assert.equal(getEloBracket(1600), 'diamond');
});

test('sameBracket returns true for same bracket', () => {
  assert.equal(sameBracket(1000, 1100), true);
  assert.equal(sameBracket(1200, 1350), true);
});

test('sameBracket returns false for different brackets', () => {
  assert.equal(sameBracket(999, 1000), false);
  assert.equal(sameBracket(1000, 1200), false);
});

// ─── EloRatingService tests ───────────────────────────────────────────────────

test('EloRatingService initialises new users at default ELO 1000', () => {
  const svc = new EloRatingService();
  assert.equal(svc.getRating('alice'), 1000);
});

test('EloRatingService getBracket returns silver for default ELO', () => {
  const svc = new EloRatingService();
  assert.equal(svc.getBracket('alice'), 'silver');
});

test('EloRatingService processSwipe skip reduces subject ELO', () => {
  const svc = new EloRatingService();
  const result = svc.processSwipe('viewer', 'subject', 'skip');
  assert.ok(result.subjectDelta < 0, 'subject should lose ELO on skip');
  assert.ok(result.subjectNewRating < 1000);
});

test('EloRatingService processSwipe skip applies draw for viewer (S=0.5)', () => {
  const svc = new EloRatingService();
  // Equal ratings → expected = 0.5, actual = 0.5 → delta = 0
  const result = svc.processSwipe('viewer', 'subject', 'skip');
  assert.equal(result.viewerDelta, 0, 'viewer delta should be 0 when equally rated and outcome is draw');
});

test('EloRatingService processSwipe hold increases subject ELO', () => {
  const svc = new EloRatingService();
  const result = svc.processSwipe('viewer', 'subject', 'hold');
  assert.ok(result.subjectDelta > 0, 'subject should gain ELO on hold');
  assert.ok(result.subjectNewRating > 1000);
});

test('EloRatingService processSwipe increments interactionCount', () => {
  const svc = new EloRatingService();
  svc.processSwipe('v', 's', 'skip');
  assert.equal(svc.getRecord('v').interactionCount, 1);
  assert.equal(svc.getRecord('s').interactionCount, 1);
});

test('EloRatingService K-factor transitions after 30 interactions', () => {
  const svc = new EloRatingService();
  // Prime the viewer with 30 skips against unique subjects to reach the threshold.
  for (let i = 0; i < 30; i++) {
    svc.processSwipe('v', `s${i}`, 'skip');
  }
  assert.equal(getDynamicKFactor(svc.getRecord('v').interactionCount), 20);
});
