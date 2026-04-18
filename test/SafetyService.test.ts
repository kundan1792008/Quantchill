import test from 'node:test';
import assert from 'node:assert/strict';
import { SafetyService } from '../src/services/SafetyService';

test('SafetyService.block and isBlocked are bidirectional', () => {
  const s = new SafetyService();
  assert.equal(s.block('a', 'b'), true);
  assert.equal(s.isBlocked('a', 'b'), true);
  assert.equal(s.isBlocked('b', 'a'), true, 'block should apply in both directions for matching');
  assert.equal(s.block('a', 'b'), false, 'duplicate block returns false');
});

test('SafetyService refuses self-block', () => {
  const s = new SafetyService();
  assert.equal(s.block('a', 'a'), false);
  assert.equal(s.isBlocked('a', 'a'), false);
});

test('SafetyService.unblock clears the pair', () => {
  const s = new SafetyService();
  s.block('a', 'b');
  assert.equal(s.unblock('a', 'b'), true);
  assert.equal(s.isBlocked('a', 'b'), false);
  assert.equal(s.unblock('a', 'b'), false);
});

test('SafetyService.filterCandidates removes blocked users', () => {
  const s = new SafetyService();
  s.block('me', 'x');
  const candidates = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  const filtered = s.filterCandidates('me', candidates);
  assert.deepEqual(filtered.map((c) => c.id), ['y', 'z']);

  // Works with raw string ids too.
  const ids = ['x', 'y', 'z'];
  assert.deepEqual(s.filterCandidates('me', ids), ['y', 'z']);
});

test('SafetyService auto-blocks subject after threshold reporters', () => {
  let now = 1_000_000;
  const s = new SafetyService({
    autoBlockThreshold: 3,
    autoBlockWindowMs: 60_000,
    nowFn: () => now
  });

  s.report({ reporterId: 'r1', subjectId: 'bad', reason: 'harassment' });
  s.report({ reporterId: 'r2', subjectId: 'bad', reason: 'harassment' });
  assert.equal(s.isAutoBlocked('bad'), false);

  s.report({ reporterId: 'r3', subjectId: 'bad', reason: 'harassment' });
  assert.equal(s.isAutoBlocked('bad'), true);

  // Auto-blocked user is hidden from any viewer.
  assert.equal(s.isBlocked('fresh', 'bad'), true);
});

test('SafetyService deduplicates reports from same reporter in window', () => {
  let now = 1_000_000;
  const s = new SafetyService({
    autoBlockThreshold: 2,
    autoBlockWindowMs: 60_000,
    nowFn: () => now
  });

  assert.ok(s.report({ reporterId: 'r1', subjectId: 'bad', reason: 'spam' }));
  assert.equal(s.report({ reporterId: 'r1', subjectId: 'bad', reason: 'spam' }), null);
  assert.equal(s.reportCount('bad'), 1);
  assert.equal(s.isAutoBlocked('bad'), false);
});

test('SafetyService rolling window expires old reports', () => {
  let now = 1_000_000;
  const s = new SafetyService({
    autoBlockThreshold: 3,
    autoBlockWindowMs: 60_000,
    nowFn: () => now
  });

  s.report({ reporterId: 'r1', subjectId: 'bad', reason: 'spam' });
  s.report({ reporterId: 'r2', subjectId: 'bad', reason: 'spam' });

  // Advance past the window.
  now += 60_001;

  assert.equal(s.reportCount('bad'), 0);
  s.report({ reporterId: 'r3', subjectId: 'bad', reason: 'spam' });
  assert.equal(s.isAutoBlocked('bad'), false);
});

test('SafetyService.report ignores self-reports and empty ids', () => {
  const s = new SafetyService();
  assert.equal(s.report({ reporterId: 'a', subjectId: 'a', reason: 'other' }), null);
  assert.equal(s.report({ reporterId: '', subjectId: 'a', reason: 'other' }), null);
  assert.equal(s.report({ reporterId: 'a', subjectId: '', reason: 'other' }), null);
});

test('SafetyService.listBlocks returns explicit blocks only', () => {
  const s = new SafetyService({ autoBlockThreshold: 1, nowFn: () => 1 });
  s.block('a', 'b');
  s.report({ reporterId: 'x', subjectId: 'c', reason: 'spam' });
  assert.deepEqual(s.listBlocks('a'), ['b']);
  assert.ok(s.isAutoBlocked('c'));
  assert.deepEqual(s.listBlocks('anyone'), []);
});
