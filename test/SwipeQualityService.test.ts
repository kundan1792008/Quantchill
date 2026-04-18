import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SwipeQualityService,
  LOW_QUALITY_MEDIAN_MS,
  LOW_QUALITY_WEIGHT,
  DEFAULT_SUPERLIKE_QUOTA,
  median,
  nextUtcMidnightIso,
  utcDateKey
} from '../src/services/SwipeQualityService';
import { UserWellbeingSettingsService } from '../src/services/UserWellbeingSettings';

test('median handles odd and even length arrays', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
});

test('nextUtcMidnightIso is strictly after now and ends in 00:00:00.000Z', () => {
  const now = new Date('2026-03-14T23:45:00Z');
  const iso = nextUtcMidnightIso(now);
  assert.equal(iso, '2026-03-15T00:00:00.000Z');
  assert.ok(new Date(iso).getTime() > now.getTime());
});

test('nextUtcMidnightIso is UTC-based (unaffected by local DST)', () => {
  // Two instants around a typical US DST transition – both should produce
  // the next UTC midnight, not a shifted local midnight.
  const before = new Date('2026-03-08T06:30:00Z');
  const after = new Date('2026-03-08T07:30:00Z');
  assert.equal(nextUtcMidnightIso(before), '2026-03-09T00:00:00.000Z');
  assert.equal(nextUtcMidnightIso(after), '2026-03-09T00:00:00.000Z');
});

test('utcDateKey formats as YYYY-MM-DD', () => {
  assert.equal(utcDateKey(new Date('2026-01-09T00:00:00Z')), '2026-01-09');
});

test('recordSwipe returns full weight when decisions are slow', () => {
  const svc = new SwipeQualityService();
  let result = { weight: 0, takeABreakSuggested: false, medianDecisionTimeMs: 0, windowSize: 0 };
  for (let i = 0; i < 10; i++) {
    result = svc.recordSwipe('u1', { timestamp: i * 1000, decisionTimeMs: 1200 });
  }
  assert.equal(result.weight, 1);
  assert.equal(result.takeABreakSuggested, false);
  assert.ok(result.medianDecisionTimeMs >= LOW_QUALITY_MEDIAN_MS);
});

test('recordSwipe downweights and suggests a break on fast swiping', () => {
  const svc = new SwipeQualityService();
  let result = { weight: 0, takeABreakSuggested: false, medianDecisionTimeMs: 0, windowSize: 0 };
  for (let i = 0; i < 10; i++) {
    result = svc.recordSwipe('u1', { timestamp: i * 200, decisionTimeMs: 120 });
  }
  assert.equal(result.weight, LOW_QUALITY_WEIGHT);
  assert.equal(result.takeABreakSuggested, true);
  assert.ok(result.medianDecisionTimeMs < LOW_QUALITY_MEDIAN_MS);
});

test('recordSwipe rejects negative or non-finite decision times', () => {
  const svc = new SwipeQualityService();
  assert.throws(() => svc.recordSwipe('u1', { timestamp: 0, decisionTimeMs: -1 }));
  assert.throws(() =>
    svc.recordSwipe('u1', { timestamp: 0, decisionTimeMs: Number.POSITIVE_INFINITY })
  );
});

test('superlikes: default quota, consume decrements, extra consumption fails', () => {
  const svc = new SwipeQualityService();
  const initial = svc.getSuperlikeState('u1');
  assert.equal(initial.dailyQuota, DEFAULT_SUPERLIKE_QUOTA);
  assert.equal(initial.remaining, DEFAULT_SUPERLIKE_QUOTA);
  for (let i = 0; i < DEFAULT_SUPERLIKE_QUOTA; i++) {
    assert.equal(svc.consumeSuperlike('u1'), true);
  }
  assert.equal(svc.consumeSuperlike('u1'), false);
  assert.equal(svc.getSuperlikeState('u1').remaining, 0);
});

test('superlike resetsAt is informational (ISO) and after now', () => {
  const fixedNow = new Date('2026-04-01T12:00:00Z').getTime();
  const svc = new SwipeQualityService({ now: () => fixedNow });
  const state = svc.getSuperlikeState('u1');
  assert.equal(state.resetsAt, '2026-04-02T00:00:00.000Z');
});

test('daily summary caps inter-swipe gaps to avoid background-time inflation', () => {
  const svc = new SwipeQualityService();
  // Two swipes 10 minutes apart → gap capped at 90s → ~2 minutes
  svc.recordSwipe('u1', { timestamp: 0, decisionTimeMs: 800 });
  svc.recordSwipe('u1', { timestamp: 10 * 60_000, decisionTimeMs: 800 });
  svc.recordSwipe('u1', { timestamp: 10 * 60_000 + 30_000, decisionTimeMs: 800 });
  const s = svc.getDailyUsageSummary('u1');
  assert.equal(s.swipes, 3);
  // First gap capped at 90s (1.5min) + second gap 30s (0.5min) = 2 minutes
  assert.equal(s.activeMinutes, 2);
});

test('daily summary surfaces limit-reached flag from settings', () => {
  const settings = new UserWellbeingSettingsService();
  settings.update('u1', { dailyTimeLimitMinutes: 5 });
  const svc = new SwipeQualityService({ settings });
  // Three swipes with capped gaps totaling ~3 minutes – under 5min limit.
  svc.recordSwipe('u1', { timestamp: 0, decisionTimeMs: 800 });
  svc.recordSwipe('u1', { timestamp: 90_000, decisionTimeMs: 800 });
  svc.recordSwipe('u1', { timestamp: 180_000, decisionTimeMs: 800 });
  let s = svc.getDailyUsageSummary('u1');
  assert.equal(s.dailyTimeLimitMinutes, 5);
  assert.equal(s.limitReached, false);
  // Add enough swipes to exceed 5 minutes of capped active time.
  for (let i = 1; i <= 5; i++) {
    svc.recordSwipe('u1', { timestamp: 180_000 + i * 90_000, decisionTimeMs: 800 });
  }
  s = svc.getDailyUsageSummary('u1');
  assert.ok(s.activeMinutes >= 5, `expected ≥5 active minutes, got ${s.activeMinutes}`);
  assert.equal(s.limitReached, true);
});

test('recordMatch and recordNewConversation feed the daily summary', () => {
  const svc = new SwipeQualityService();
  svc.recordMatch('u1');
  svc.recordMatch('u1');
  svc.recordNewConversation('u1');
  const s = svc.getDailyUsageSummary('u1');
  assert.equal(s.matches, 2);
  assert.equal(s.newConversations, 1);
});
