import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySortedSetStore, MatchQueue } from '../src/services/MatchQueue';

test('InMemorySortedSetStore zadd + zscore + zcard', () => {
  const s = new InMemorySortedSetStore();
  s.zadd('k', 100, 'a');
  s.zadd('k', 200, 'b');
  assert.equal(s.zscore('k', 'a'), 100);
  assert.equal(s.zcard('k'), 2);
});

test('InMemorySortedSetStore zrange is ascending by score', () => {
  const s = new InMemorySortedSetStore();
  s.zadd('k', 3, 'c');
  s.zadd('k', 1, 'a');
  s.zadd('k', 2, 'b');
  const range = s.zrange('k', 0, -1).map((m) => m.member);
  assert.deepEqual(range, ['a', 'b', 'c']);
});

test('InMemorySortedSetStore zpopmin returns and removes the lowest', () => {
  const s = new InMemorySortedSetStore();
  s.zadd('k', 3, 'c');
  s.zadd('k', 1, 'a');
  const popped = s.zpopmin('k');
  assert.equal(popped?.member, 'a');
  assert.equal(s.zcard('k'), 1);
});

test('InMemorySortedSetStore zrangebyscore is inclusive on both ends', () => {
  const s = new InMemorySortedSetStore();
  s.zadd('k', 10, 'a');
  s.zadd('k', 20, 'b');
  s.zadd('k', 30, 'c');
  const range = s.zrangebyscore('k', 10, 20).map((m) => m.member);
  assert.deepEqual(range, ['a', 'b']);
});

test('MatchQueue enqueue places user into correct bracket set', () => {
  let now = 1_000;
  const q = new MatchQueue({ now: () => now });
  const rec = q.enqueue('u1', 1250); // gold
  assert.equal(rec.bracket, 'gold');
  assert.equal(q.size('gold'), 1);
  assert.equal(q.size('silver'), 0);
});

test('MatchQueue dequeue returns the longest-waiting user first', () => {
  let now = 0;
  const q = new MatchQueue({ now: () => now });
  q.enqueue('first', 1000);
  now += 100;
  q.enqueue('second', 1050);
  const head = q.dequeue('silver');
  assert.equal(head?.userId, 'first');
});

test('MatchQueue findMatch returns the closest-ELO peer in the bracket', () => {
  const q = new MatchQueue();
  q.enqueue('a', 1200); // gold
  q.enqueue('b', 1220); // gold
  q.enqueue('c', 1390); // still gold
  const match = q.findMatch('a');
  assert.equal(match?.userId, 'b');
});

test('MatchQueue findMatch returns null when no peers are within radius', () => {
  const q = new MatchQueue({ baseRadius: 50 });
  q.enqueue('a', 1000);
  q.enqueue('b', 1080); // still silver bracket but 80 apart > 50 radius
  const match = q.findMatch('a');
  assert.equal(match, null);
});

test('MatchQueue findMatch expands radius by 50 every 5 s of waiting', () => {
  let now = 0;
  const q = new MatchQueue({ baseRadius: 50, radiusIncrement: 50, radiusIntervalMs: 5000, now: () => now });
  q.enqueue('a', 1000);
  now = 100;
  q.enqueue('b', 1120); // 120 away
  // At t=100 (no expansion), radius=50, no match.
  assert.equal(q.findMatch('a'), null);
  // Advance to 15 s → radius = 50 + 3*50 = 200, match 'b'.
  now = 15_500;
  const matched = q.findMatch('a');
  assert.equal(matched?.userId, 'b');
});

test('MatchQueue maxRadius caps expansion growth', () => {
  let now = 0;
  const q = new MatchQueue({
    baseRadius: 100,
    radiusIncrement: 100,
    radiusIntervalMs: 1000,
    maxRadius: 200,
    now: () => now
  });
  q.enqueue('a', 1000);
  now = 100_000;
  assert.equal(q.currentRadius('a'), 200);
});

test('MatchQueue popMatch removes both peers and emits a match event', () => {
  const q = new MatchQueue();
  q.enqueue('a', 1200);
  q.enqueue('b', 1220);
  let payload: unknown = null;
  q.on('match', (m) => {
    payload = m;
  });
  const pair = q.popMatch('a');
  assert.ok(pair);
  assert.equal(q.size('gold'), 0);
  assert.ok(payload);
});

test('MatchQueue remove deletes from both bracket sets', () => {
  const q = new MatchQueue();
  q.enqueue('a', 1500);
  assert.ok(q.remove('a'));
  assert.equal(q.size('platinum'), 0);
  assert.equal(q.remove('a'), false);
});

test('MatchQueue emits enqueue/dequeue events', () => {
  const q = new MatchQueue();
  const emitted: string[] = [];
  q.on('enqueue', (r) => emitted.push(`enq:${r.userId}`));
  q.on('dequeue', (r) => emitted.push(`deq:${r.userId}`));
  q.enqueue('x', 1000);
  q.dequeue('silver');
  assert.deepEqual(emitted, ['enq:x', 'deq:x']);
});
