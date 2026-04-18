import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchSignaling } from '../src/services/MatchSignaling';

/** Deterministic scheduler driven by an explicit clock. */
function fakeScheduler() {
  let nextId = 1;
  const timers = new Map<number, { cb: () => void; dueAt: number }>();
  let now = 0;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of Array.from(timers.entries())) {
        if (t.dueAt <= now) {
          timers.delete(id);
          t.cb();
        }
      }
    },
    scheduler: {
      setTimeout: (cb: () => void, delay: number) => {
        const id = nextId++;
        timers.set(id, { cb, dueAt: now + delay });
        return id as unknown as NodeJS.Timeout;
      },
      clearTimeout: (handle: NodeJS.Timeout) => {
        timers.delete(handle as unknown as number);
      }
    }
  };
}

test('MatchSignaling.createRoom allocates a unique room and notifies both peers', () => {
  const delivered: Array<{ userId: string; payload: any }> = [];
  const fs = fakeScheduler();
  const sig = new MatchSignaling({
    broadcast: (userId, payload) => delivered.push({ userId, payload }),
    now: fs.now,
    scheduler: fs.scheduler
  });
  const room = sig.createRoom('a', 'b');
  assert.ok(room.roomId);
  assert.equal(room.status, 'pending');
  assert.equal(delivered.length, 2);
  const [msg1, msg2] = delivered;
  assert.equal(msg1.payload.type, 'match-found');
  assert.equal(msg1.payload.roomId, room.roomId);
  assert.equal(msg1.payload.initiator, true);
  assert.equal(msg2.payload.initiator, false);
});

test('MatchSignaling.markConnected transitions room to active when both peers join', () => {
  const fs = fakeScheduler();
  const sig = new MatchSignaling({ now: fs.now, scheduler: fs.scheduler });
  const room = sig.createRoom('a', 'b');
  let active: any = null;
  sig.on('room-active', (r) => {
    active = r;
  });
  sig.markConnected(room.roomId, 'a');
  assert.equal(sig.getRoom(room.roomId)?.status, 'pending');
  sig.markConnected(room.roomId, 'b');
  assert.equal(sig.getRoom(room.roomId)?.status, 'active');
  assert.ok(active);
});

test('MatchSignaling times out after connectTimeoutMs and calls onTimeout', () => {
  const fs = fakeScheduler();
  let timedOut: any = null;
  const sig = new MatchSignaling({
    connectTimeoutMs: 10_000,
    now: fs.now,
    scheduler: fs.scheduler,
    onTimeout: (r) => {
      timedOut = r;
    }
  });
  sig.createRoom('a', 'b');
  fs.advance(9_999);
  assert.equal(timedOut, null);
  fs.advance(2);
  assert.ok(timedOut);
  assert.equal(timedOut.status, 'timeout');
  assert.equal(sig.roomCount(), 0);
});

test('MatchSignaling timeout does NOT fire once room is active', () => {
  const fs = fakeScheduler();
  let timedOut: any = null;
  const sig = new MatchSignaling({
    connectTimeoutMs: 5_000,
    now: fs.now,
    scheduler: fs.scheduler,
    onTimeout: (r) => {
      timedOut = r;
    }
  });
  const room = sig.createRoom('a', 'b');
  sig.markConnected(room.roomId, 'a');
  sig.markConnected(room.roomId, 'b');
  fs.advance(10_000);
  assert.equal(timedOut, null);
});

test('MatchSignaling.relay forwards the payload to the other peer only', () => {
  const delivered: Array<{ userId: string; payload: any }> = [];
  const fs = fakeScheduler();
  const sig = new MatchSignaling({
    broadcast: (userId, payload) => delivered.push({ userId, payload }),
    now: fs.now,
    scheduler: fs.scheduler
  });
  const room = sig.createRoom('a', 'b');
  delivered.length = 0;
  const ok = sig.relay(room.roomId, 'a', { sdp: 'offer' });
  assert.equal(ok, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].userId, 'b');
  assert.equal(delivered[0].payload.type, 'signal-relay');
});

test('MatchSignaling.closeRoom notifies both peers and removes state', () => {
  const fs = fakeScheduler();
  const sig = new MatchSignaling({ now: fs.now, scheduler: fs.scheduler });
  const room = sig.createRoom('a', 'b');
  sig.closeRoom(room.roomId, 'user-hangup');
  assert.equal(sig.getRoom(room.roomId), null);
  assert.equal(sig.getRoomForUser('a'), null);
});
