import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MatchSignaling,
  type SignalingOutbound,
  type TimerLike,
  type TimerHandle
} from '../src/services/MatchSignaling';

interface FakeTimer extends TimerLike {
  advance(ms: number): void;
  scheduled(): number;
}

function makeFakeTimer(): FakeTimer {
  let currentTime = 1_000_000;
  const pending = new Map<number, { fireAt: number; fn: () => void }>();
  let nextHandle = 1;

  return {
    now: () => currentTime,
    setTimeout(fn, ms) {
      const handle = nextHandle++;
      pending.set(handle, { fireAt: currentTime + ms, fn });
      return handle as TimerHandle;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
    advance(ms: number) {
      currentTime += ms;
      for (const [h, { fireAt, fn }] of Array.from(pending.entries())) {
        if (fireAt <= currentTime) {
          pending.delete(h);
          fn();
        }
      }
    },
    scheduled() {
      return pending.size;
    }
  };
}

function makeSignaling() {
  const outbox: Array<{ userId: string; message: SignalingOutbound }> = [];
  const timeouts: string[] = [];
  const timer = makeFakeTimer();
  const signaling = new MatchSignaling(
    (userId, message) => outbox.push({ userId, message }),
    (room) => timeouts.push(room.roomId),
    { connectTimeoutMs: 10_000 },
    timer
  );
  return { signaling, outbox, timeouts, timer };
}

test('MatchSignaling.createRoom pushes match-found to both participants', () => {
  const { signaling, outbox } = makeSignaling();
  const room = signaling.createRoom('alice', 'bob');

  assert.equal(outbox.length, 2);
  assert.equal(outbox[0]!.message.type, 'match-found');
  const userIds = outbox.map((o) => o.userId).sort();
  assert.deepEqual(userIds, ['alice', 'bob']);
  assert.equal(room.status, 'pending');
  assert.equal(room.participants.length, 2);
  assert.equal(room.participants[0]!.role, 'polite');
  assert.equal(room.participants[1]!.role, 'impolite');
});

test('MatchSignaling assigns roles deterministically by userId ordering', () => {
  const { signaling } = makeSignaling();
  const room = signaling.createRoom('zed', 'aaron');
  const aaron = room.participants.find((p) => p.userId === 'aaron')!;
  const zed = room.participants.find((p) => p.userId === 'zed')!;
  assert.equal(aaron.role, 'polite');
  assert.equal(zed.role, 'impolite');
});

test('MatchSignaling.relayOffer forwards SDP to the other peer only', () => {
  const { signaling, outbox } = makeSignaling();
  const room = signaling.createRoom('alice', 'bob');
  outbox.length = 0;
  signaling.relayOffer(room.roomId, 'alice', { sdp: 'v=0…' });

  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.userId, 'bob');
  assert.equal(outbox[0]!.message.type, 'offer');
});

test('MatchSignaling.markConnected → both sides yields connected status', () => {
  const { signaling, timer } = makeSignaling();
  const room = signaling.createRoom('a', 'b');
  signaling.markConnected(room.roomId, 'a');
  const final = signaling.markConnected(room.roomId, 'b');
  assert.equal(final.status, 'connected');
  // Connect timer should have been cancelled.
  assert.equal(timer.scheduled(), 0);
});

test('MatchSignaling expires a room and invokes onTimeout after 10 seconds', () => {
  const { signaling, timer, timeouts, outbox } = makeSignaling();
  const room = signaling.createRoom('x', 'y');
  outbox.length = 0;

  timer.advance(9_999);
  assert.equal(timeouts.length, 0);

  timer.advance(2);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0], room.roomId);
  assert.ok(outbox.some((o) => o.message.type === 'room-expired'));
});

test('MatchSignaling.closeRoom emits room-closed and drops the room', () => {
  const { signaling, outbox } = makeSignaling();
  const room = signaling.createRoom('m', 'n');
  outbox.length = 0;
  const result = signaling.closeRoom(room.roomId, 'user-ended');
  assert.ok(result);
  assert.equal(outbox.length, 2);
  assert.ok(outbox.every((o) => o.message.type === 'room-closed'));
  assert.equal(signaling.getRoom(room.roomId), null);
});

test('MatchSignaling tracks rooms per user and cleans up on close', () => {
  const { signaling } = makeSignaling();
  const room = signaling.createRoom('p', 'q');
  assert.deepEqual(signaling.roomsForUser('p'), [room.roomId]);
  signaling.closeRoom(room.roomId, 'done');
  assert.deepEqual(signaling.roomsForUser('p'), []);
});

test('MatchSignaling rejects createRoom for identical participants', () => {
  const { signaling } = makeSignaling();
  assert.throws(() => signaling.createRoom('self', 'self'));
});
