import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeedCallManager, CALL_DURATION_MS } from '../src/services/SpeedCallManager';
import type { CallSession, QualityReport, SpeedSignalingMessage } from '../src/services/SpeedCallManager';
import type { SpeedMatchPair } from '../src/services/SpeedDatingQueue';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FROZEN = new Date('2024-01-01T12:00:00Z').getTime();

function makePair(
  userAId = 'alice',
  userBId = 'bob',
  roomId = 'room-1'
): SpeedMatchPair {
  return {
    roomId,
    userA: { userId: userAId, age: 25, theme: null, enqueuedAt: FROZEN },
    userB: { userId: userBId, age: 27, theme: null, enqueuedAt: FROZEN },
    matchedAt: FROZEN
  };
}

function makeManager(nowFn?: () => number): SpeedCallManager {
  return new SpeedCallManager(nowFn ?? (() => FROZEN));
}

// ─── startSession ─────────────────────────────────────────────────────────────

test('SpeedCallManager startSession returns a CallSession snapshot', () => {
  const m = makeManager();
  const session = m.startSession(makePair());
  assert.equal(session.userAId, 'alice');
  assert.equal(session.userBId, 'bob');
  assert.equal(session.roomId, 'room-1');
  assert.equal(session.startedAt, FROZEN);
  assert.equal(session.endsAt, FROZEN + CALL_DURATION_MS);
  assert.equal(session.quality, 'good');
  m.clear();
});

test('SpeedCallManager startSession emits call-started', (t, done) => {
  const m = makeManager();
  m.once('call-started', (session: CallSession) => {
    assert.equal(session.userAId, 'alice');
    m.clear();
    done();
  });
  m.startSession(makePair());
});

test('SpeedCallManager hasSession returns true after start', () => {
  const m = makeManager();
  const session = m.startSession(makePair());
  assert.equal(m.hasSession(session.sessionId), true);
  m.clear();
});

test('SpeedCallManager activeSessionCount increments on start', () => {
  const m = makeManager();
  m.startSession(makePair('a', 'b', 'r1'));
  m.startSession(makePair('c', 'd', 'r2'));
  assert.equal(m.activeSessionCount(), 2);
  m.clear();
});

test('SpeedCallManager sessionForRoom returns correct sessionId', () => {
  const m = makeManager();
  const session = m.startSession(makePair('a', 'b', 'my-room'));
  assert.equal(m.sessionForRoom('my-room'), session.sessionId);
  m.clear();
});

test('SpeedCallManager sessionForRoom returns null for unknown room', () => {
  const m = makeManager();
  assert.equal(m.sessionForRoom('no-such-room'), null);
});

test('SpeedCallManager getSession returns snapshot', () => {
  const m = makeManager();
  const session = m.startSession(makePair());
  const snap = m.getSession(session.sessionId);
  assert.ok(snap !== null);
  assert.equal(snap!.sessionId, session.sessionId);
  m.clear();
});

test('SpeedCallManager getSession returns null for unknown id', () => {
  const m = makeManager();
  assert.equal(m.getSession('nonexistent'), null);
});

// ─── remainingMs ─────────────────────────────────────────────────────────────

test('SpeedCallManager remainingMs returns full duration at start', () => {
  const m = makeManager();
  const session = m.startSession(makePair());
  assert.equal(m.remainingMs(session.sessionId), CALL_DURATION_MS);
  m.clear();
});

test('SpeedCallManager remainingMs decreases with time', () => {
  let tick = FROZEN;
  const m = makeManager(() => tick);
  const session = m.startSession(makePair());
  tick += 5_000;
  assert.equal(m.remainingMs(session.sessionId), CALL_DURATION_MS - 5_000);
  m.clear();
});

test('SpeedCallManager remainingMs returns 0 for unknown session', () => {
  const m = makeManager();
  assert.equal(m.remainingMs('nope'), 0);
});

// ─── endSession ──────────────────────────────────────────────────────────────

test('SpeedCallManager endSession removes session', () => {
  const m = makeManager();
  const session = m.startSession(makePair());
  m.endSession(session.sessionId, 'user-ended');
  assert.equal(m.hasSession(session.sessionId), false);
  assert.equal(m.activeSessionCount(), 0);
});

test('SpeedCallManager endSession emits call-ended with reason', (t, done) => {
  const m = makeManager();
  const session = m.startSession(makePair());
  m.once('call-ended', (sessionId: string, reason: string) => {
    assert.equal(sessionId, session.sessionId);
    assert.equal(reason, 'user-ended');
    done();
  });
  m.endSession(session.sessionId, 'user-ended');
});

test('SpeedCallManager endSession returns false for unknown session', () => {
  const m = makeManager();
  assert.equal(m.endSession('bad-id'), false);
});

test('SpeedCallManager endSession returns false for already-ended session', () => {
  const m = makeManager();
  const session = m.startSession(makePair());
  m.endSession(session.sessionId, 'user-ended');
  assert.equal(m.endSession(session.sessionId, 'user-ended'), false);
});

// ─── relay ────────────────────────────────────────────────────────────────────

test('SpeedCallManager relay forwards offer message', (t, done) => {
  const m = makeManager();
  const session = m.startSession(makePair('alice', 'bob'));
  m.once('signal', (msg: SpeedSignalingMessage) => {
    assert.equal(msg.type, 'offer');
    assert.equal(msg.fromUserId, 'alice');
    assert.equal(msg.toUserId, 'bob');
    m.clear();
    done();
  });
  const accepted = m.relay({
    type: 'offer',
    fromUserId: 'alice',
    toUserId: 'bob',
    payload: { sdp: 'fake-sdp' },
    sessionId: session.sessionId
  });
  assert.equal(accepted, true);
});

test('SpeedCallManager relay rejects unknown session', () => {
  const m = makeManager();
  assert.equal(
    m.relay({
      type: 'offer',
      fromUserId: 'alice',
      toUserId: 'bob',
      payload: {},
      sessionId: 'bad-session'
    }),
    false
  );
});

test('SpeedCallManager relay rejects non-participant sender', () => {
  const m = makeManager();
  const session = m.startSession(makePair('alice', 'bob'));
  assert.equal(
    m.relay({
      type: 'ice-candidate',
      fromUserId: 'charlie',
      toUserId: 'bob',
      payload: {},
      sessionId: session.sessionId
    }),
    false
  );
  m.clear();
});

test('SpeedCallManager relay rejects same-user send', () => {
  const m = makeManager();
  const session = m.startSession(makePair('alice', 'bob'));
  assert.equal(
    m.relay({
      type: 'answer',
      fromUserId: 'alice',
      toUserId: 'alice',
      payload: {},
      sessionId: session.sessionId
    }),
    false
  );
  m.clear();
});

// ─── verifyToken ─────────────────────────────────────────────────────────────

test('SpeedCallManager verifyToken returns false for wrong token', () => {
  const m = makeManager();
  const session = m.startSession(makePair());
  assert.equal(m.verifyToken(session.sessionId, 'wrong-token'), false);
  m.clear();
});

// ─── quality reporting ────────────────────────────────────────────────────────

test('SpeedCallManager reportQuality emits quality-changed on downgrade', (t, done) => {
  const m = makeManager();
  const session = m.startSession(makePair('alice', 'bob'));
  m.once('quality-changed', (sessionId: string, quality: string) => {
    assert.equal(sessionId, session.sessionId);
    assert.equal(quality, 'medium');
    m.clear();
    done();
  });
  m.reportQuality({ sessionId: session.sessionId, userId: 'alice', quality: 'medium' });
});

test('SpeedCallManager reportQuality ignores non-participant', () => {
  const m = makeManager();
  const session = m.startSession(makePair('alice', 'bob'));
  let changed = false;
  m.once('quality-changed', () => { changed = true; });
  m.reportQuality({ sessionId: session.sessionId, userId: 'charlie', quality: 'poor' });
  assert.equal(changed, false);
  m.clear();
});

test('SpeedCallManager reportQuality emits rematch-token after consecutive disconnects', (t, done) => {
  const m = makeManager();
  const session = m.startSession(makePair('alice', 'bob'));
  const tokens: string[] = [];
  m.on('rematch-token', (_userId: string, token: string) => {
    tokens.push(token);
    if (tokens.length === 2) {
      assert.equal(tokens.length, 2);
      done();
    }
  });
  // Both users report disconnected 3 times (threshold = 3).
  const badQuality: QualityReport = { sessionId: session.sessionId, userId: 'alice', quality: 'disconnected' };
  const badQualityB: QualityReport = { sessionId: session.sessionId, userId: 'bob', quality: 'disconnected' };
  m.reportQuality(badQuality);
  m.reportQuality(badQualityB);
  m.reportQuality(badQuality);
  m.reportQuality(badQualityB);
  m.reportQuality(badQuality);
  m.reportQuality(badQualityB); // 3rd consecutive disconnect from both
});

test('SpeedCallManager endSession on disconnect ends the session', (t, done) => {
  const m = makeManager();
  const session = m.startSession(makePair('alice', 'bob'));
  m.once('call-ended', (_id: string, reason: string) => {
    assert.equal(reason, 'disconnected');
    done();
  });
  const rep: QualityReport = { sessionId: session.sessionId, userId: 'alice', quality: 'disconnected' };
  const repB: QualityReport = { sessionId: session.sessionId, userId: 'bob', quality: 'disconnected' };
  m.reportQuality(rep);
  m.reportQuality(repB);
  m.reportQuality(rep);
  m.reportQuality(repB);
  m.reportQuality(rep);
  m.reportQuality(repB);
});

// ─── call-warning (timer) ─────────────────────────────────────────────────────

test('SpeedCallManager emits call-warning before call ends', (t, done) => {
  // Use real timers; warning fires at 50 s, call ends at 60 s.
  const m = new SpeedCallManager();
  const session = m.startSession(makePair());
  m.once('call-warning', (sessionId: string, remainingMs: number) => {
    assert.equal(sessionId, session.sessionId);
    assert.equal(remainingMs, 10_000);
    m.clear();
    done();
  });
}, { timeout: 55_000 });

// ─── clear ────────────────────────────────────────────────────────────────────

test('SpeedCallManager clear removes all sessions', () => {
  const m = makeManager();
  m.startSession(makePair('a', 'b', 'r1'));
  m.startSession(makePair('c', 'd', 'r2'));
  m.clear();
  assert.equal(m.activeSessionCount(), 0);
});
