import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchQueue } from '../src/services/MatchQueue';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeQueue(): MatchQueue {
  return new MatchQueue();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('MatchQueue enqueue adds user to correct bracket', () => {
  const q = makeQueue();
  const entry = q.enqueue('u1', 1050); // silver bracket
  assert.equal(entry.userId, 'u1');
  assert.equal(entry.bracket, 'silver');
  assert.equal(q.queueSize('silver'), 1);
  assert.equal(q.totalQueued(), 1);
});

test('MatchQueue isQueued returns true after enqueue', () => {
  const q = makeQueue();
  q.enqueue('u1', 1000);
  assert.equal(q.isQueued('u1'), true);
});

test('MatchQueue remove removes user from queue', () => {
  const q = makeQueue();
  q.enqueue('u1', 1000);
  const removed = q.remove('u1');
  assert.equal(removed, true);
  assert.equal(q.isQueued('u1'), false);
  assert.equal(q.totalQueued(), 0);
});

test('MatchQueue remove returns false for unknown user', () => {
  const q = makeQueue();
  assert.equal(q.remove('unknown'), false);
});

test('MatchQueue dequeue pops longest-waiting user', async () => {
  const q = makeQueue();
  q.enqueue('u1', 1000);
  // Small delay to ensure different enqueuedAt timestamps.
  await new Promise((resolve) => setTimeout(resolve, 5));
  q.enqueue('u2', 1010);

  const popped = q.dequeue('silver');
  assert.equal(popped?.userId, 'u1'); // u1 waited longer
  assert.equal(q.queueSize('silver'), 1);
});

test('MatchQueue dequeue returns null for empty bracket', () => {
  const q = makeQueue();
  assert.equal(q.dequeue('diamond'), null);
});

test('MatchQueue findMatch pairs two users in the same bracket', () => {
  const q = makeQueue();
  q.enqueue('u1', 1000);
  q.enqueue('u2', 1050);

  const pair = q.findMatch('u1');
  assert.ok(pair !== null, 'Expected a match');
  assert.equal(pair!.userA.userId, 'u1');
  assert.equal(pair!.userB.userId, 'u2');
  // Both removed from queue after match.
  assert.equal(q.totalQueued(), 0);
});

test('MatchQueue findMatch returns null when no candidates within radius', () => {
  const q = makeQueue();
  q.enqueue('u1', 1000);
  q.enqueue('u2', 1600); // 600 pts away – outside initial radius of 200

  const pair = q.findMatch('u1');
  assert.equal(pair, null);
  assert.equal(q.totalQueued(), 2); // both still queued
});

test('MatchQueue findMatch returns null for unknown user', () => {
  const q = makeQueue();
  assert.equal(q.findMatch('nobody'), null);
});

test('MatchQueue re-enqueue updates bracket if ELO changed', () => {
  const q = makeQueue();
  q.enqueue('u1', 1000); // silver
  q.enqueue('u1', 1600); // now diamond – should update
  assert.equal(q.queueSize('silver'), 0);
  assert.equal(q.queueSize('diamond'), 1);
});

test('MatchQueue emits match-found event', (t, done) => {
  const q = makeQueue();
  q.once('match-found', (pair) => {
    assert.equal(pair.userA.userId, 'u1');
    done();
  });
  q.enqueue('u1', 1000);
  q.enqueue('u2', 1010);
  q.findMatch('u1');
});

test('MatchQueue peekQueue returns snapshot without dequeuing', () => {
  const q = makeQueue();
  q.enqueue('u1', 1000);
  q.enqueue('u2', 1050);
  const snapshot = q.peekQueue('silver');
  assert.equal(snapshot.length, 2);
  // Original queue untouched.
  assert.equal(q.queueSize('silver'), 2);
});

test('MatchQueue clear empties all brackets', () => {
  const q = makeQueue();
  q.enqueue('u1', 1000);
  q.enqueue('u2', 1400);
  q.clear();
  assert.equal(q.totalQueued(), 0);
});
