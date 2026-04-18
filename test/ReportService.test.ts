import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportService } from '../src/services/ReportService';

test('ReportService rejects self-reports', () => {
  const svc = new ReportService();
  assert.throws(() => svc.report({ reporterId: 'a', targetId: 'a' }));
});

test('ReportService stores a report and returns a summary', () => {
  const svc = new ReportService();
  const { summary } = svc.report({ reporterId: 'a', targetId: 'b', reason: 'spam' });
  assert.equal(summary.totalReports, 1);
  assert.equal(summary.banned, false);
});

test('ReportService auto-bans after 3 distinct reporters', () => {
  const svc = new ReportService({ banThreshold: 3 });
  svc.report({ reporterId: 'r1', targetId: 'bad' });
  svc.report({ reporterId: 'r2', targetId: 'bad' });
  assert.equal(svc.isBanned('bad'), false);
  svc.report({ reporterId: 'r3', targetId: 'bad' });
  assert.equal(svc.isBanned('bad'), true);
});

test('ReportService does NOT auto-ban on duplicate reporter', () => {
  const svc = new ReportService({ banThreshold: 3 });
  for (let i = 0; i < 5; i += 1) {
    svc.report({ reporterId: 'same', targetId: 'bad' });
  }
  assert.equal(svc.isBanned('bad'), false);
});

test('ReportService unban removes from ban list', () => {
  const svc = new ReportService({ banThreshold: 2 });
  svc.report({ reporterId: 'r1', targetId: 'bad' });
  svc.report({ reporterId: 'r2', targetId: 'bad' });
  assert.equal(svc.isBanned('bad'), true);
  svc.unban('bad');
  assert.equal(svc.isBanned('bad'), false);
});

test('ReportService summary counts distinct reporters separately from total', () => {
  const svc = new ReportService({ banThreshold: 10 });
  svc.report({ reporterId: 'r1', targetId: 'bad' });
  svc.report({ reporterId: 'r1', targetId: 'bad' });
  svc.report({ reporterId: 'r2', targetId: 'bad' });
  const summary = svc.summary('bad');
  assert.equal(summary.totalReports, 3);
  assert.equal(summary.distinctReporters, 2);
});
