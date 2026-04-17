import test from 'node:test';
import assert from 'node:assert/strict';
import { InterestGraph, decayWeight } from '../src/services/InterestGraph';
import { GlickoEngine } from '../src/services/GlickoEngine';
import { SwipeProcessor } from '../src/services/SwipeProcessor';

test('InterestGraph.applySignal creates a directed edge with the given delta', () => {
  const graph = new InterestGraph();
  const edge = graph.applySignal({
    userId: 'a',
    targetId: 'b',
    delta: 4,
    reasons: ['like', 'long-dwell'],
    positive: true
  });
  assert.equal(edge.weight, 4);
  assert.equal(edge.source, 'a');
  assert.equal(edge.target, 'b');
  assert.equal(graph.edgeCount(), 1);
});

test('InterestGraph edges are directed (a→b does NOT imply b→a)', () => {
  const graph = new InterestGraph();
  graph.addEdge('a', 'b', 3);
  assert.ok(graph.getEdge('a', 'b'));
  assert.equal(graph.getEdge('b', 'a'), null);
});

test('InterestGraph.addEdge accumulates weights across multiple signals', () => {
  const graph = new InterestGraph();
  graph.addEdge('a', 'b', 2);
  graph.addEdge('a', 'b', 3);
  const edge = graph.getEdge('a', 'b')!;
  assert.equal(edge.weight, 5);
  assert.equal(edge.interactionCount, 2);
});

test('decayWeight is monotonically non-increasing in elapsed time', () => {
  const halfLife = 1000;
  const a = decayWeight(10, 0, halfLife);
  const b = decayWeight(10, 500, halfLife);
  const c = decayWeight(10, 1000, halfLife);
  const d = decayWeight(10, 2000, halfLife);
  assert.ok(a >= b && b >= c && c >= d);
  assert.ok(Math.abs(c - 5) < 1e-9);
  assert.ok(Math.abs(d - 2.5) < 1e-9);
});

test('InterestGraph.getNeighbors returns sorted-desc positive edges', () => {
  const graph = new InterestGraph();
  graph.addEdge('me', 'low', 1);
  graph.addEdge('me', 'high', 9);
  graph.addEdge('me', 'mid', 5);
  const top = graph.getNeighbors('me', 2);
  assert.equal(top.length, 2);
  assert.equal(top[0]!.target, 'high');
  assert.equal(top[1]!.target, 'mid');
});

test('InterestGraph.mutualMatches requires bidirectional edges above threshold', () => {
  const graph = new InterestGraph({ mutualThreshold: 3 });
  graph.addEdge('a', 'b', 5);
  graph.addEdge('b', 'a', 4);
  graph.addEdge('a', 'c', 5);
  graph.addEdge('c', 'a', 2); // below threshold
  const matches = graph.mutualMatches('a');
  assert.deepEqual(matches.sort(), ['b']);
});

test('InterestGraph.getRecommendations uses collaborative filtering', () => {
  const graph = new InterestGraph({ positiveThreshold: 1 });
  // Both `me` and `twin` like `X`, `Y`; `twin` additionally likes `Z`.
  graph.addEdge('me', 'X', 5);
  graph.addEdge('me', 'Y', 5);
  graph.addEdge('twin', 'X', 5);
  graph.addEdge('twin', 'Y', 5);
  graph.addEdge('twin', 'Z', 8);
  // An unrelated user also rates Z but shares nothing with `me`.
  graph.addEdge('stranger', 'Z', 10);
  graph.addEdge('stranger', 'W', 10);

  const recs = graph.getRecommendations('me', 3);
  assert.ok(recs.length > 0);
  assert.equal(recs[0]!.userId, 'Z');
});

test('InterestGraph.getRecommendations never recommends already-rated targets', () => {
  const graph = new InterestGraph({ positiveThreshold: 1 });
  graph.addEdge('me', 'X', 5);
  graph.addEdge('peer', 'X', 5);
  graph.addEdge('peer', 'Y', 5);
  const recs = graph.getRecommendations('me', 5).map((r) => r.userId);
  assert.ok(!recs.includes('X'));
  assert.ok(recs.includes('Y'));
});

test('InterestGraph serialises and restores losslessly', () => {
  const graph = new InterestGraph();
  graph.addEdge('a', 'b', 3);
  graph.addEdge('a', 'c', 5);
  const snap = graph.snapshot();

  const reborn = new InterestGraph();
  reborn.restore(snap);
  assert.equal(reborn.edgeCount(), 2);
  assert.equal(reborn.getEdge('a', 'c')?.weight, 5);
});

test('SwipeProcessor → InterestGraph end-to-end: a like creates a positive edge', () => {
  const glicko = new GlickoEngine();
  const processor = new SwipeProcessor(glicko, {}, () => 0);
  const graph = new InterestGraph();
  processor.onCompatibility((sig) => graph.applySignal(sig));

  processor.process({
    userId: 'alice',
    targetId: 'bob',
    action: 'like',
    dwellTimeMs: 4000,
    scrollVelocity: 50
  });

  const edge = graph.getEdge('alice', 'bob');
  assert.ok(edge);
  assert.ok(edge!.weight >= 3);
});
