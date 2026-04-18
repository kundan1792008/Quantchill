import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/services/RateLimiter';

test('RateLimiter allows up to capacity then blocks', () => {
  let now = 1_000_000;
  const rl = new RateLimiter({ swipe: { capacity: 3, refillPerSec: 1 } }, () => now);

  assert.equal(rl.consume('u1', 'swipe').allowed, true);
  assert.equal(rl.consume('u1', 'swipe').allowed, true);
  assert.equal(rl.consume('u1', 'swipe').allowed, true);

  const blocked = rl.consume('u1', 'swipe');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0, 'retryAfterMs should be positive when blocked');
});

test('RateLimiter refills tokens over time', () => {
  let now = 0;
  const rl = new RateLimiter({ act: { capacity: 2, refillPerSec: 2 } }, () => now);

  assert.equal(rl.consume('u', 'act').allowed, true);
  assert.equal(rl.consume('u', 'act').allowed, true);
  assert.equal(rl.consume('u', 'act').allowed, false);

  // Advance 600ms → 1.2 tokens refilled → one more allowed
  now += 600;
  assert.equal(rl.consume('u', 'act').allowed, true);
  assert.equal(rl.consume('u', 'act').allowed, false);
});

test('RateLimiter isolates buckets per (key, action)', () => {
  let now = 0;
  const rl = new RateLimiter(
    {
      swipe: { capacity: 1, refillPerSec: 1 },
      match: { capacity: 1, refillPerSec: 1 }
    },
    () => now
  );

  assert.equal(rl.consume('a', 'swipe').allowed, true);
  assert.equal(rl.consume('a', 'swipe').allowed, false);

  // Different action for same key must still be allowed.
  assert.equal(rl.consume('a', 'match').allowed, true);

  // Different key, same action must still be allowed.
  assert.equal(rl.consume('b', 'swipe').allowed, true);
});

test('RateLimiter allows unknown actions through', () => {
  const rl = new RateLimiter({ swipe: { capacity: 1, refillPerSec: 1 } }, () => 0);
  const decision = rl.consume('u', 'unknown');
  assert.equal(decision.allowed, true);
  assert.equal(decision.remaining, Number.POSITIVE_INFINITY);
});

test('RateLimiter.reset clears a key across actions', () => {
  let now = 0;
  const rl = new RateLimiter(
    {
      a: { capacity: 1, refillPerSec: 1 },
      b: { capacity: 1, refillPerSec: 1 }
    },
    () => now
  );

  rl.consume('k', 'a');
  rl.consume('k', 'b');
  assert.equal(rl.consume('k', 'a').allowed, false);
  assert.equal(rl.consume('k', 'b').allowed, false);

  rl.reset('k');

  assert.equal(rl.consume('k', 'a').allowed, true);
  assert.equal(rl.consume('k', 'b').allowed, true);
});

test('RateLimiter constructor rejects invalid rules', () => {
  assert.throws(() => new RateLimiter({ bad: { capacity: 0, refillPerSec: 1 } }));
  assert.throws(() => new RateLimiter({ bad: { capacity: 1, refillPerSec: 0 } }));
});

test('RateLimiter.peek does not consume tokens', () => {
  let now = 0;
  const rl = new RateLimiter({ act: { capacity: 2, refillPerSec: 1 } }, () => now);
  assert.equal(rl.peek('u', 'act'), 2);
  assert.equal(rl.peek('u', 'act'), 2);
  rl.consume('u', 'act');
  assert.equal(rl.peek('u', 'act'), 1);
});
