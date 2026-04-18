import test from 'node:test';
import assert from 'node:assert/strict';
import { InterestGraph } from '../src/services/InterestGraph';

test('InterestGraph recordAction creates a symmetric edge', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'b', 'like');
  assert.equal(g.getEdge('a', 'b'), 2);
  assert.equal(g.getEdge('b', 'a'), 2);
});

test('InterestGraph superlike weighs more than like', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'b', 'superlike');
  assert.equal(g.getEdge('a', 'b'), 5);
});

test('InterestGraph skip does not create an edge on its own', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'b', 'skip');
  assert.equal(g.getEdge('a', 'b'), 0);
});

test('InterestGraph skip after like reduces weight but keeps edge until 0', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'b', 'like');
  g.recordAction('a', 'b', 'skip');
  // weight = max(0, 2-1) = 1
  assert.equal(g.getEdge('a', 'b'), 1);
  g.recordAction('a', 'b', 'skip');
  // now 0 → edge removed
  assert.equal(g.getEdge('a', 'b'), 0);
  assert.equal(g.neighbours('a').size, 0);
});

test('InterestGraph neighbours returns a defensive copy', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'b', 'like');
  const n = g.neighbours('a');
  n.set('b', 9999);
  assert.equal(g.getEdge('a', 'b'), 2);
});

test('InterestGraph getRecommendations finds two-hop candidates', () => {
  const g = new InterestGraph();
  // a ↔ b, b ↔ c, so c should be recommended to a.
  g.recordAction('a', 'b', 'like');
  g.recordAction('b', 'c', 'like');
  const recs = g.getRecommendations('a', 5);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].userId, 'c');
  assert.equal(recs[0].supportingPaths, 1);
});

test('InterestGraph getRecommendations aggregates multiple paths', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'b1', 'like');
  g.recordAction('a', 'b2', 'like');
  g.recordAction('b1', 'c', 'like');
  g.recordAction('b2', 'c', 'like');
  const recs = g.getRecommendations('a', 5);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].userId, 'c');
  assert.equal(recs[0].supportingPaths, 2);
});

test('InterestGraph getRecommendations excludes direct neighbours', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'b', 'like');
  g.recordAction('b', 'a', 'like'); // a already direct-edges to b
  const recs = g.getRecommendations('a', 5);
  assert.equal(recs.find((r) => r.userId === 'b'), undefined);
});

test('InterestGraph getRecommendations truncates to count', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'hub', 'like');
  for (let i = 0; i < 10; i += 1) {
    g.recordAction('hub', `c${i}`, 'like');
  }
  const recs = g.getRecommendations('a', 3);
  assert.equal(recs.length, 3);
});

test('InterestGraph edgeCount tracks undirected edges', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'b', 'like');
  g.recordAction('b', 'c', 'like');
  assert.equal(g.edgeCount(), 2);
});

test('InterestGraph topNeighbours returns neighbours in weight order', () => {
  const g = new InterestGraph();
  g.recordAction('a', 'b', 'like'); // weight 2
  g.recordAction('a', 'c', 'superlike'); // weight 5
  const top = g.topNeighbours('a', 10);
  assert.equal(top[0].userId, 'c');
  assert.equal(top[1].userId, 'b');
});
