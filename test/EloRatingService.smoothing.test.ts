import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EloRatingService,
  RATING_SMOOTHING_ALPHA,
  emaSmooth
} from '../src/services/EloRatingService';
import { UserWellbeingSettingsService } from '../src/services/UserWellbeingSettings';

test('emaSmooth blends raw and previous with alpha', () => {
  // alpha=0.2, raw=1040, prev=1000 => 0.2*1040 + 0.8*1000 = 1008
  assert.equal(emaSmooth(1040, 1000), 1008);
});

test('emaSmooth rejects alpha out of (0,1]', () => {
  assert.throws(() => emaSmooth(1000, 1000, 0));
  assert.throws(() => emaSmooth(1000, 1000, 1.1));
});

test('smoothedRating moves less than raw rating after a single swipe', () => {
  const svc = new EloRatingService();
  svc.processSwipe('A', 'B', 'skip');
  const a = svc.getRecord('A');
  const b = svc.getRecord('B');
  // A gained (viewer draw S=0.5 with equal ratings => unchanged), B lost.
  // Check that smoothed rating of the loser is strictly between its previous
  // smoothed (1000) and its new raw.
  const deltaRaw = 1000 - b.rating;
  const deltaSmoothed = 1000 - b.smoothedRating;
  assert.ok(deltaRaw > 0, 'subject should have lost raw rating');
  assert.ok(
    deltaSmoothed > 0 && deltaSmoothed < deltaRaw,
    `smoothed delta ${deltaSmoothed} should be > 0 and < raw delta ${deltaRaw}`
  );
  // Sanity: alpha-based bound
  assert.equal(a.smoothedRating, emaSmooth(a.rating, 1000));
});

test('getDisplayRating returns null when settings hide rating (default)', () => {
  const settings = new UserWellbeingSettingsService();
  const svc = new EloRatingService(settings);
  svc.processSwipe('A', 'B', 'hold');
  assert.equal(svc.getDisplayRating('A'), null);
});

test('getDisplayRating returns smoothed value after user opts in', () => {
  const settings = new UserWellbeingSettingsService();
  const svc = new EloRatingService(settings);
  svc.processSwipe('A', 'B', 'hold');
  settings.update('A', { hideEloRating: false });
  const shown = svc.getDisplayRating('A');
  assert.equal(shown, svc.getRecord('A').smoothedRating);
});

test('getRatingHistory returns null when rating is hidden (no side-channel leak)', () => {
  const settings = new UserWellbeingSettingsService();
  const svc = new EloRatingService(settings);
  svc.processSwipe('A', 'B', 'hold');
  assert.equal(svc.getRatingHistory('A'), null);
});

test('getRatingHistory returns points after opt-in and filters by sinceMs', async () => {
  const settings = new UserWellbeingSettingsService();
  settings.update('A', { hideEloRating: false });
  const svc = new EloRatingService(settings);
  svc.processSwipe('A', 'B', 'hold');
  await new Promise((r) => setTimeout(r, 5));
  const t1 = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  svc.processSwipe('A', 'B', 'skip');
  const all = svc.getRatingHistory('A');
  assert.ok(all && all.length >= 2);
  const since = svc.getRatingHistory('A', t1);
  assert.ok(since && since.length >= 1 && since.every((p) => p.timestamp >= t1));
});

test('smoothing constant is the documented value (guard against accidental retune)', () => {
  assert.equal(RATING_SMOOTHING_ALPHA, 0.2);
});
