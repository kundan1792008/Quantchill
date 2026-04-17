import test from 'node:test';
import assert from 'node:assert/strict';
import { PostCallVoting, VOTING_WINDOW_MS } from '../src/services/PostCallVoting';
import type {
  MutualMatchResult,
  FomoNotification,
  VotingResult,
  VoteRecord
} from '../src/services/PostCallVoting';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FROZEN = new Date('2024-01-01T12:00:00Z').getTime();

function makeVoting(nowFn?: () => number): PostCallVoting {
  return new PostCallVoting(nowFn ?? (() => FROZEN));
}

// ─── openVoting ───────────────────────────────────────────────────────────────

test('PostCallVoting openVoting returns the sessionId', () => {
  const v = makeVoting();
  const id = v.openVoting('session-1', 'alice', 'bob');
  assert.equal(id, 'session-1');
});

test('PostCallVoting openVoting marks session as open', () => {
  const v = makeVoting();
  v.openVoting('session-1', 'alice', 'bob');
  assert.equal(v.isOpen('session-1'), true);
});

test('PostCallVoting openVoting throws on duplicate sessionId', () => {
  const v = makeVoting();
  v.openVoting('session-1', 'alice', 'bob');
  assert.throws(() => v.openVoting('session-1', 'alice', 'bob'), /already open/);
});

test('PostCallVoting isOpen returns false for unknown session', () => {
  const v = makeVoting();
  assert.equal(v.isOpen('unknown'), false);
});

// ─── castVote ─────────────────────────────────────────────────────────────────

test('PostCallVoting castVote returns a VoteRecord', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  const rec = v.castVote('s1', 'alice', 'heart');
  assert.equal(rec.sessionId, 's1');
  assert.equal(rec.userId, 'alice');
  assert.equal(rec.vote, 'heart');
  assert.equal(rec.castAt, FROZEN);
});

test('PostCallVoting castVote emits vote-cast', (t, done) => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.once('vote-cast', (rec: VoteRecord) => {
    assert.equal(rec.userId, 'alice');
    done();
  });
  v.castVote('s1', 'alice', 'next');
});

test('PostCallVoting castVote throws for unknown session', () => {
  const v = makeVoting();
  assert.throws(() => v.castVote('nope', 'alice', 'heart'), /No open voting session/);
});

test('PostCallVoting castVote throws for non-participant', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  assert.throws(() => v.castVote('s1', 'charlie', 'heart'), /not a participant/);
});

test('PostCallVoting castVote throws on double vote', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.castVote('s1', 'alice', 'heart');
  assert.throws(() => v.castVote('s1', 'alice', 'next'), /already voted/);
});

// ─── Mutual match ─────────────────────────────────────────────────────────────

test('PostCallVoting mutual match emits mutual-match event', (t, done) => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.once('mutual-match', (result: MutualMatchResult) => {
    assert.equal(result.sessionId, 's1');
    assert.equal(result.userAId, 'alice');
    assert.equal(result.userBId, 'bob');
    assert.ok(typeof result.chatRoomId === 'string' && result.chatRoomId.length > 0);
    done();
  });
  v.castVote('s1', 'alice', 'heart');
  v.castVote('s1', 'bob', 'heart');
});

test('PostCallVoting mutual match outcome stored in history', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.castVote('s1', 'alice', 'heart');
  v.castVote('s1', 'bob', 'heart');
  const result = v.getResult('s1');
  assert.ok(result !== null);
  assert.equal(result!.outcome, 'mutual-match');
});

test('PostCallVoting mutual match closes session immediately', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.castVote('s1', 'alice', 'heart');
  v.castVote('s1', 'bob', 'heart');
  assert.equal(v.isOpen('s1'), false);
});

// ─── One-sided (FOMO) ─────────────────────────────────────────────────────────

test('PostCallVoting one-sided emits fomo-notification to skipping user', (t, done) => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.once('fomo-notification', (notif: FomoNotification) => {
    // Bob skipped, so he is the recipient.
    assert.equal(notif.recipientId, 'bob');
    assert.equal(notif.admirerId, 'alice');
    assert.ok(notif.message.length > 0);
    done();
  });
  v.castVote('s1', 'alice', 'heart');
  v.castVote('s1', 'bob', 'next');
});

test('PostCallVoting one-sided (B hearts, A skips) notifies A', (t, done) => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.once('fomo-notification', (notif: FomoNotification) => {
    assert.equal(notif.recipientId, 'alice');
    assert.equal(notif.admirerId, 'bob');
    done();
  });
  v.castVote('s1', 'alice', 'next');
  v.castVote('s1', 'bob', 'heart');
});

test('PostCallVoting one-sided outcome stored correctly', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.castVote('s1', 'alice', 'heart');
  v.castVote('s1', 'bob', 'next');
  const result = v.getResult('s1');
  assert.equal(result!.outcome, 'one-sided');
  assert.equal(result!.voteA, 'heart');
  assert.equal(result!.voteB, 'next');
});

// ─── Both skip ────────────────────────────────────────────────────────────────

test('PostCallVoting both-skipped outcome stores correctly', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.castVote('s1', 'alice', 'next');
  v.castVote('s1', 'bob', 'next');
  const result = v.getResult('s1');
  assert.equal(result!.outcome, 'both-skipped');
});

test('PostCallVoting both-skip does NOT emit mutual-match', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  let fired = false;
  v.once('mutual-match', () => { fired = true; });
  v.castVote('s1', 'alice', 'next');
  v.castVote('s1', 'bob', 'next');
  assert.equal(fired, false);
});

// ─── Timeout ──────────────────────────────────────────────────────────────────

test('PostCallVoting timeout closes session and emits voting-closed', (t, done) => {
  const v = new PostCallVoting();
  v.openVoting('s-timeout', 'alice', 'bob');
  v.once('voting-closed', (sessionId: string) => {
    assert.equal(sessionId, 's-timeout');
    assert.equal(v.isOpen('s-timeout'), false);
    done();
  });
}, { timeout: VOTING_WINDOW_MS + 2000 });

test('PostCallVoting timeout with no votes treats both as next (both-skipped)', (t, done) => {
  const v = new PostCallVoting();
  v.openVoting('s-to2', 'alice', 'bob');
  v.once('voting-closed', () => {
    const result = v.getResult('s-to2');
    assert.equal(result!.outcome, 'both-skipped');
    assert.equal(result!.voteA, null);
    assert.equal(result!.voteB, null);
    done();
  });
}, { timeout: VOTING_WINDOW_MS + 2000 });

test('PostCallVoting timeout with one heart emits vote-timeout for non-voter', (t, done) => {
  const v = new PostCallVoting();
  v.openVoting('s-to3', 'alice', 'bob');
  v.castVote('s-to3', 'alice', 'heart');
  v.once('vote-timeout', (sessionId: string, timedOutUserId: string) => {
    assert.equal(sessionId, 's-to3');
    assert.equal(timedOutUserId, 'bob');
    done();
  });
}, { timeout: VOTING_WINDOW_MS + 2000 });

test('PostCallVoting closeVoting manually closes a session', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.closeVoting('s1');
  assert.equal(v.isOpen('s1'), false);
});

// ─── getResult ────────────────────────────────────────────────────────────────

test('PostCallVoting getResult returns pending for open session', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  const result = v.getResult('s1');
  assert.equal(result!.outcome, 'pending');
  assert.equal(result!.resolvedAt, null);
});

test('PostCallVoting getResult returns null for unknown session', () => {
  const v = makeVoting();
  assert.equal(v.getResult('nope'), null);
});

// ─── getStats ─────────────────────────────────────────────────────────────────

test('PostCallVoting getStats returns zeros for unknown user', () => {
  const v = makeVoting();
  const stats = v.getStats('nobody');
  assert.equal(stats.totalCalls, 0);
  assert.equal(stats.mutualMatches, 0);
  assert.equal(stats.matchRate, 0);
});

test('PostCallVoting getStats counts mutual matches correctly', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.castVote('s1', 'alice', 'heart');
  v.castVote('s1', 'bob', 'heart');

  v.openVoting('s2', 'alice', 'charlie');
  v.castVote('s2', 'alice', 'next');
  v.castVote('s2', 'charlie', 'next');

  const stats = v.getStats('alice');
  assert.equal(stats.totalCalls, 2);
  assert.equal(stats.mutualMatches, 1);
  assert.equal(stats.heartsGiven, 1);
  assert.equal(stats.heartsReceived, 1);
  assert.ok(Math.abs(stats.matchRate - 50) < 0.01);
});

test('PostCallVoting getStats matchRate is 0 when no mutual matches', () => {
  const v = makeVoting();
  v.openVoting('s1', 'alice', 'bob');
  v.castVote('s1', 'alice', 'next');
  v.castVote('s1', 'bob', 'next');
  const stats = v.getStats('alice');
  assert.equal(stats.matchRate, 0);
});

// ─── getVoteHistory ───────────────────────────────────────────────────────────

test('PostCallVoting getVoteHistory returns all resolved results', () => {
  const v = makeVoting();
  v.openVoting('s1', 'a', 'b');
  v.castVote('s1', 'a', 'heart');
  v.castVote('s1', 'b', 'next');

  v.openVoting('s2', 'c', 'd');
  v.castVote('s2', 'c', 'next');
  v.castVote('s2', 'd', 'next');

  const history = v.getVoteHistory();
  assert.equal(history.length, 2);
});

// ─── openSessionCount ─────────────────────────────────────────────────────────

test('PostCallVoting openSessionCount increments and decrements', () => {
  const v = makeVoting();
  assert.equal(v.openSessionCount(), 0);
  v.openVoting('s1', 'a', 'b');
  v.openVoting('s2', 'c', 'd');
  assert.equal(v.openSessionCount(), 2);
  v.castVote('s1', 'a', 'next');
  v.castVote('s1', 'b', 'next');
  assert.equal(v.openSessionCount(), 1);
});

// ─── clear ────────────────────────────────────────────────────────────────────

test('PostCallVoting clear removes all open sessions', () => {
  const v = makeVoting();
  v.openVoting('s1', 'a', 'b');
  v.openVoting('s2', 'c', 'd');
  v.clear();
  assert.equal(v.openSessionCount(), 0);
});

test('PostCallVoting clear does not remove history', () => {
  const v = makeVoting();
  v.openVoting('s1', 'a', 'b');
  v.castVote('s1', 'a', 'heart');
  v.castVote('s1', 'b', 'heart');
  v.clear();
  assert.equal(v.getVoteHistory().length, 1);
});
