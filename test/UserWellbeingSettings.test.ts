import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UserWellbeingSettingsService,
  defaultSettings,
  validateUpdate
} from '../src/services/UserWellbeingSettings';

test('defaultSettings hides rating and disables break reminders', () => {
  const s = defaultSettings('u1');
  assert.equal(s.hideEloRating, true);
  assert.equal(s.breakRemindersEnabled, false);
  assert.equal(s.dailyTimeLimitMinutes, null);
});

test('get() creates conservative defaults on first read', () => {
  const svc = new UserWellbeingSettingsService();
  const s = svc.get('u1');
  assert.equal(s.hideEloRating, true);
  assert.equal(s.breakRemindersEnabled, false);
});

test('update() applies partial changes and leaves other fields intact', () => {
  const svc = new UserWellbeingSettingsService();
  svc.get('u1');
  const updated = svc.update('u1', { hideEloRating: false });
  assert.equal(updated.hideEloRating, false);
  assert.equal(updated.breakRemindersEnabled, false);
  const again = svc.update('u1', { breakRemindersEnabled: true });
  assert.equal(again.hideEloRating, false, 'prior change must persist');
  assert.equal(again.breakRemindersEnabled, true);
});

test('validateUpdate rejects out-of-range daily limits', () => {
  assert.throws(() => validateUpdate({ dailyTimeLimitMinutes: 0 }));
  assert.throws(() => validateUpdate({ dailyTimeLimitMinutes: 4 }));
  assert.throws(() => validateUpdate({ dailyTimeLimitMinutes: 24 * 60 + 1 }));
});

test('validateUpdate accepts null, 5, and 1440 as boundary values', () => {
  assert.doesNotThrow(() => validateUpdate({ dailyTimeLimitMinutes: null }));
  assert.doesNotThrow(() => validateUpdate({ dailyTimeLimitMinutes: 5 }));
  assert.doesNotThrow(() => validateUpdate({ dailyTimeLimitMinutes: 1440 }));
});

test('isRatingVisible reflects current setting', () => {
  const svc = new UserWellbeingSettingsService();
  assert.equal(svc.isRatingVisible('u1'), false);
  svc.update('u1', { hideEloRating: false });
  assert.equal(svc.isRatingVisible('u1'), true);
});
