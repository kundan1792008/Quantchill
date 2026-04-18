import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/server';

test('API /api/swipe returns Glicko ratings and compatibility signals', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/swipe',
    payload: { userId: 'api-a', targetId: 'api-b', action: 'like', dwellTimeMs: 4000, scrollVelocity: 50 }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.action, 'like');
  assert.ok(body.reasons.includes('high-dwell'));
  assert.ok(body.reasons.includes('careful-browsing'));
  assert.ok(body.viewerElo.rating > 0);
  assert.ok(body.targetElo.rating > 0);
});

test('API /api/swipe rejects self-swipe with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/swipe',
    payload: { userId: 'x', targetId: 'x', action: 'like', dwellTimeMs: 100, scrollVelocity: 100 }
  });
  assert.equal(res.statusCode, 400);
});

test('API /api/swipe rejects unknown action with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/swipe',
    payload: { userId: 'a', targetId: 'b', action: 'poke', dwellTimeMs: 100, scrollVelocity: 100 }
  });
  assert.equal(res.statusCode, 400);
});

test('API /api/matches returns mutual matches after bidirectional likes', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/swipe',
    payload: { userId: 'mm-a', targetId: 'mm-b', action: 'like', dwellTimeMs: 100, scrollVelocity: 200 }
  });
  await app.inject({
    method: 'POST',
    url: '/api/swipe',
    payload: { userId: 'mm-b', targetId: 'mm-a', action: 'like', dwellTimeMs: 100, scrollVelocity: 200 }
  });
  const res = await app.inject({ method: 'GET', url: '/api/matches?userId=mm-a' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.matches.length, 1);
  assert.equal(body.matches[0].userId, 'mm-b');
});

test('API /api/recommendations returns two-hop collaborative-filtering picks', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/swipe',
    payload: { userId: 'rec-a', targetId: 'rec-b', action: 'like', dwellTimeMs: 100, scrollVelocity: 200 }
  });
  await app.inject({
    method: 'POST',
    url: '/api/swipe',
    payload: { userId: 'rec-b', targetId: 'rec-c', action: 'like', dwellTimeMs: 100, scrollVelocity: 200 }
  });
  const res = await app.inject({ method: 'GET', url: '/api/recommendations?userId=rec-a&count=5' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.recommendations.some((r: { userId: string }) => r.userId === 'rec-c'));
});

test('API /api/report auto-bans target after 3 distinct reporters', async () => {
  const target = 'banned-target-' + Date.now();
  for (const reporter of ['r1', 'r2', 'r3']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/report',
      payload: { reporterId: reporter, targetId: target, reason: 'harassment' }
    });
    assert.equal(res.statusCode, 200);
  }
  const final = await app.inject({
    method: 'POST',
    url: '/api/report',
    payload: { reporterId: 'r4', targetId: target }
  });
  const body = final.json();
  assert.equal(body.summary.banned, true);
});

test('API /api/report rejects self-report with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/report',
    payload: { reporterId: 'a', targetId: 'a' }
  });
  assert.equal(res.statusCode, 400);
});

test('API /api/queue/enqueue returns queued or matched status', async () => {
  // First user queues alone.
  const r1 = await app.inject({
    method: 'POST',
    url: '/api/queue/enqueue',
    payload: { userId: 'q-user-1' }
  });
  assert.equal(r1.statusCode, 200);
  const b1 = r1.json();
  assert.equal(b1.status, 'queued');

  // Second user is matched to the first because both start at 1500.
  const r2 = await app.inject({
    method: 'POST',
    url: '/api/queue/enqueue',
    payload: { userId: 'q-user-2' }
  });
  const b2 = r2.json();
  assert.equal(b2.status, 'matched');
  assert.ok(b2.match.a.userId);
});
