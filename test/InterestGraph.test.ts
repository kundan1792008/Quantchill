import test from 'node:test';
import assert from 'node:assert/strict';
import { InterestGraph, cosineSimilarity } from '../src/services/InterestGraph';

// ─── cosineSimilarity tests ───────────────────────────────────────────────────

test('cosineSimilarity returns 1 for identical vectors', () => {
  const v = { music: 10, travel: 5 };
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-10);
});

test('cosineSimilarity returns 0 for orthogonal vectors', () => {
  const a = { music: 1 };
  const b = { sports: 1 };
  assert.equal(cosineSimilarity(a, b), 0);
});

test('cosineSimilarity returns 0 for empty vector', () => {
  assert.equal(cosineSimilarity({}, { music: 1 }), 0);
});

test('cosineSimilarity returns a value in [0, 1]', () => {
  const a = { music: 8, travel: 3 };
  const b = { music: 5, travel: 9, gaming: 2 };
  const sim = cosineSimilarity(a, b);
  assert.ok(sim >= 0 && sim <= 1, `Expected [0,1], got ${sim}`);
});

// ─── InterestGraph tests ──────────────────────────────────────────────────────

test('InterestGraph recordSwipe like increases interest weight', () => {
  const g = new InterestGraph();
  g.recordSwipe('alice', 'bob', ['music', 'travel'], 'like');
  const interests = g.getInterests('alice');
  assert.ok(interests['music']! > 0);
  assert.ok(interests['travel']! > 0);
});

test('InterestGraph recordSwipe superlike adds greater weight than like', () => {
  const g = new InterestGraph();
  g.recordSwipe('alice', 'bob', ['music'], 'superlike');
  g.recordSwipe('alice', 'carol', ['travel'], 'like');
  const interests = g.getInterests('alice');
  assert.ok(interests['music']! > interests['travel']!);
});

test('InterestGraph recordSwipe skip reduces interest weight', () => {
  const g = new InterestGraph();
  g.recordSwipe('alice', 'bob', ['sports'], 'skip');
  const interests = g.getInterests('alice');
  assert.ok(interests['sports']! < 0);
});

test('InterestGraph getSimilarity returns 0 for users with no common interests', () => {
  const g = new InterestGraph();
  g.recordSwipe('alice', 'x', ['music'], 'like');
  g.recordSwipe('bob', 'y', ['sports'], 'like');
  assert.equal(g.getSimilarity('alice', 'bob'), 0);
});

test('InterestGraph getSimilarity returns >0 for users with shared interests', () => {
  const g = new InterestGraph();
  g.recordSwipe('alice', 'x', ['music', 'travel'], 'like');
  g.recordSwipe('bob', 'y', ['music', 'travel'], 'like');
  const sim = g.getSimilarity('alice', 'bob');
  assert.ok(sim > 0, `Expected positive similarity, got ${sim}`);
});

test('InterestGraph getRecommendations excludes self', () => {
  const g = new InterestGraph();
  g.recordSwipe('alice', 'target1', ['music'], 'like');
  g.recordSwipe('alice', 'target2', ['travel'], 'like');
  const recs = g.getRecommendations('alice', 10);
  assert.ok(!recs.some((r) => r.userId === 'alice'), 'Self should not appear in recommendations');
});

test('InterestGraph getRecommendations excludes already-swiped users', () => {
  const g = new InterestGraph();
  g.seedInterests('alice', { music: 5 });
  g.recordSwipe('alice', 'bob', ['music'], 'like'); // alice already swiped bob
  g.seedInterests('bob', { music: 8 });

  const recs = g.getRecommendations('alice', 10);
  assert.ok(!recs.some((r) => r.userId === 'bob'), 'Already-swiped bob should not appear');
});

test('InterestGraph getRecommendations returns top-N sorted by similarity', () => {
  const g = new InterestGraph();
  g.seedInterests('alice', { music: 10, travel: 8 });
  g.seedInterests('bob', { music: 9, travel: 7 }); // high similarity
  g.seedInterests('carol', { sports: 10 });          // zero similarity

  const recs = g.getRecommendations('alice', 2);
  if (recs.length >= 2) {
    assert.ok(recs[0]!.similarity >= recs[1]!.similarity, 'Results should be sorted by similarity');
  }
});

test('InterestGraph getRecommendations respects count limit', () => {
  const g = new InterestGraph();
  for (let i = 0; i < 10; i++) {
    g.seedInterests(`user${i}`, { music: i + 1 });
  }
  g.seedInterests('alice', { music: 5 });
  const recs = g.getRecommendations('alice', 3);
  assert.ok(recs.length <= 3);
});

test('InterestGraph seedInterests accumulates weights', () => {
  const g = new InterestGraph();
  g.seedInterests('alice', { music: 5 });
  g.seedInterests('alice', { music: 3 });
  const interests = g.getInterests('alice');
  assert.equal(interests['music'], 8);
});

test('InterestGraph getAllUserIds lists known users', () => {
  const g = new InterestGraph();
  g.seedInterests('alice', { music: 1 });
  g.seedInterests('bob', { travel: 1 });
  const ids = g.getAllUserIds();
  assert.ok(ids.includes('alice'));
  assert.ok(ids.includes('bob'));
});
