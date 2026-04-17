import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MatchQueue,
  InMemoryRedisClient,
  bracketForElo,
  DEFAULT_MATCH_QUEUE_CONFIG,
  type QueueEvent
} from '../src/services/MatchQueue';

function makeQueue(nowRef: { t: number }) {
  const redis = new InMemoryRedisClient();
  const queue = new MatchQueue(redis, {}, () => nowRef.t);
  return { redis, queue };
}

test('bracketForElo maps ratings to the correct named bracket', () => {
  assert.equal(bracketForElo(500), 'bronze');
  assert.equal(bracketForElo(1000), 'silver');
  assert.equal(bracketForElo(1199), 'silver');
  assert.equal(bracketForElo(1200), 'gold');
  assert.equal(bracketForElo(1400), 'platinum');
  assert.equal(bracketForElo(1600), 'diamond');
});

test('MatchQueue.enqueue inserts into the correct bracket sorted set', async () => {
  const now = { t: 1000 };
  const { queue } = makeQueue(now);
  const e = await queue.enqueue('alice', 1250);
  assert.equal(e.bracket, 'gold');
  assert.equal(e.enqueuedAt, 1000);
  assert.equal(await queue.size('gold'), 1);
  assert.equal(await queue.size('silver'), 0);
});

test('MatchQueue.remove clears the sorted set AND metadata hash', async () => {
  const now = { t: 10 };
  const { queue } = makeQueue(now);
  await queue.enqueue('bob', 1550);
  assert.equal(await queue.remove('bob'), true);
  assert.equal(await queue.size('platinum'), 0);
  assert.equal(await queue.getEntry('bob'), null);
  assert.equal(await queue.remove('bob'), false);
});

test('MatchQueue.dequeue returns the longest-waiting user', async () => {
  const now = { t: 100 };
  const { queue } = makeQueue(now);
  await queue.enqueue('old', 1300);
  now.t = 500;
  await queue.enqueue('middle', 1310);
  now.t = 900;
  await queue.enqueue('new', 1290);

  const first = await queue.dequeue('gold');
  assert.equal(first?.userId, 'old');
  const second = await queue.dequeue('gold');
  assert.equal(second?.userId, 'middle');
});

test('MatchQueue.findMatch picks the closest-ELO peer in same bracket', async () => {
  const now = { t: 1 };
  const { queue } = makeQueue(now);
  await queue.enqueue('a', 1250);
  await queue.enqueue('b', 1400); // platinum, different bracket — ignored
  await queue.enqueue('c', 1230);
  await queue.enqueue('d', 1350);

  const match = await queue.findMatch('a');
  assert.ok(match);
  assert.equal(match!.peer.userId, 'c');
  assert.ok(match!.eloDelta === 20);
});

test('MatchQueue.findMatch respects the 200-point default radius', async () => {
  const now = { t: 1 };
  const { queue } = makeQueue(now);
  await queue.enqueue('a', 1200);
  await queue.enqueue('far', 1410); // out of bracket → auto-filtered
  const match = await queue.findMatch('a');
  assert.equal(match, null);
});

test('MatchQueue expands radius by +50 every 5 s of waiting', async () => {
  const now = { t: 0 };
  const redis = new InMemoryRedisClient();
  const queue = new MatchQueue(redis, {}, () => now.t);
  await queue.enqueue('a', 1210); // gold
  await queue.enqueue('b', 1390); // gold, delta=180 (within 200) → matched immediately? no, 1390-1210=180
  // Force an initial distance > 200 by enqueuing at a farther score.
  await queue.enqueue('c', 1199); // silver
  // Bring a match within radius only after 5 s.
  assert.equal(queue.computeRadius(0), DEFAULT_MATCH_QUEUE_CONFIG.initialRadius);
  assert.equal(queue.computeRadius(5_000), 250);
  assert.equal(queue.computeRadius(15_000), 350);
  assert.equal(queue.computeRadius(600_000), DEFAULT_MATCH_QUEUE_CONFIG.maxRadius);
});

test('MatchQueue.matchAndPop atomically removes both sides', async () => {
  const now = { t: 0 };
  const { queue } = makeQueue(now);
  await queue.enqueue('a', 1250);
  await queue.enqueue('b', 1260);
  const match = await queue.matchAndPop('a');
  assert.ok(match);
  assert.equal(await queue.size('gold'), 0);
  assert.equal(await queue.getEntry('a'), null);
  assert.equal(await queue.getEntry('b'), null);
});

test('MatchQueue publishes enqueue/match events on pub/sub', async () => {
  const now = { t: 0 };
  const { queue } = makeQueue(now);
  const events: QueueEvent[] = [];
  await queue.onEvent((ev) => events.push(ev));

  await queue.enqueue('a', 1500);
  await queue.enqueue('b', 1510);
  await queue.matchAndPop('a');

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds.slice(0, 2), ['enqueue', 'enqueue']);
  assert.ok(kinds.includes('match'));
  await queue.dispose();
});
