/**
 * PostCallVoting – post-call mutual match detection for the Speed Dating
 * mini-game.
 *
 * After a 60-second call ends, both participants have a 10-second window to
 * cast a vote:
 *
 *  - "heart"  → they want to match
 *  - "next"   → skip, move on
 *
 * Outcome logic:
 *  - Both heart  → mutual match: a chat room is opened and both users receive
 *                  a confetti + match notification.
 *  - One heart   → FOMO notification sent to the heartless voter:
 *                  "They liked you!" to create anticipation.
 *  - Both next   → quiet skip, no notification.
 *
 * All vote data is persisted in an in-memory store for later consumption by the
 * Chemistry AI model (export via `getVoteHistory()`).
 *
 * Events emitted:
 *  - `vote-cast`         (record: VoteRecord)
 *  - `mutual-match`      (result: MutualMatchResult)
 *  - `fomo-notification` (notification: FomoNotification)
 *  - `vote-timeout`      (sessionId: string, timedOutUserId: string)
 *  - `voting-closed`     (sessionId: string)
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Duration of the voting window after call end (ms). */
export const VOTING_WINDOW_MS = 10_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** A user's vote choice after the call. */
export type VoteChoice = 'heart' | 'next';

/** A single vote cast by one user. */
export interface VoteRecord {
  sessionId: string;
  userId: string;
  vote: VoteChoice;
  castAt: number;
}

/** The final voting result for a session. */
export interface VotingResult {
  sessionId: string;
  userAId: string;
  userBId: string;
  voteA: VoteChoice | null;
  voteB: VoteChoice | null;
  outcome: 'mutual-match' | 'one-sided' | 'both-skipped' | 'pending';
  resolvedAt: number | null;
}

/** Emitted when both users heart — carries the new chat room ID. */
export interface MutualMatchResult {
  sessionId: string;
  userAId: string;
  userBId: string;
  chatRoomId: string;
  resolvedAt: number;
}

/** Emitted to the user who skipped when the other user hearted. */
export interface FomoNotification {
  sessionId: string;
  recipientId: string;
  admirerId: string;
  message: string;
  sentAt: number;
}

/** Internal state for a pending voting session. */
interface VotingSession {
  sessionId: string;
  userAId: string;
  userBId: string;
  voteA: VoteChoice | null;
  voteB: VoteChoice | null;
  openedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  closed: boolean;
}

// ─── PostCallVoting ───────────────────────────────────────────────────────────

/**
 * PostCallVoting manages the 10-second voting window that follows each call.
 *
 * Inject `nowFn` to control time in tests.
 */
export class PostCallVoting extends EventEmitter {
  /** Active voting sessions keyed by sessionId. */
  private readonly sessions = new Map<string, VotingSession>();

  /** Completed voting results keyed by sessionId (permanent log). */
  private readonly history = new Map<string, VotingResult>();

  private readonly nowFn: () => number;

  constructor(nowFn: () => number = Date.now) {
    super();
    this.nowFn = nowFn;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Open a new voting session for a call that has just ended.
   *
   * The session automatically closes after `VOTING_WINDOW_MS` (10 s).
   * Any votes not cast by then are treated as `null` (equivalent to "next"
   * for outcome purposes).
   *
   * @returns The new sessionId (same as the call sessionId passed in).
   */
  openVoting(sessionId: string, userAId: string, userBId: string): string {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Voting session ${sessionId} is already open.`);
    }

    const now = this.nowFn();

    const timeoutHandle = setTimeout(() => {
      this.closeVoting(sessionId);
    }, VOTING_WINDOW_MS);

    const session: VotingSession = {
      sessionId,
      userAId,
      userBId,
      voteA: null,
      voteB: null,
      openedAt: now,
      timeoutHandle,
      closed: false
    };

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  /**
   * Cast a vote for a user in an open voting session.
   *
   * If both users have now voted, the session is resolved immediately without
   * waiting for the timeout.
   *
   * Throws if:
   *  - The session does not exist or is already closed.
   *  - The userId is not a participant in the session.
   *  - The user has already voted.
   */
  castVote(sessionId: string, userId: string, vote: VoteChoice): VoteRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No open voting session for id ${sessionId}.`);
    }
    if (session.closed) {
      throw new Error(`Voting session ${sessionId} is already closed.`);
    }

    const isUserA = session.userAId === userId;
    const isUserB = session.userBId === userId;
    if (!isUserA && !isUserB) {
      throw new Error(`User ${userId} is not a participant in session ${sessionId}.`);
    }
    if (isUserA && session.voteA !== null) {
      throw new Error(`User ${userId} has already voted in session ${sessionId}.`);
    }
    if (isUserB && session.voteB !== null) {
      throw new Error(`User ${userId} has already voted in session ${sessionId}.`);
    }

    const now = this.nowFn();
    if (isUserA) {
      session.voteA = vote;
    } else {
      session.voteB = vote;
    }

    const record: VoteRecord = { sessionId, userId, vote, castAt: now };
    this.emit('vote-cast', record);

    // Both votes in – resolve early.
    if (session.voteA !== null && session.voteB !== null) {
      this.resolveSession(session);
    }

    return record;
  }

  /**
   * Force-close a voting session (called by the timeout or externally).
   *
   * Any uncast votes are treated as null (= "next").
   */
  closeVoting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    this.resolveSession(session);
  }

  /**
   * Return the voting result for a session (may still be pending if open).
   */
  getResult(sessionId: string): VotingResult | null {
    // Check completed history first.
    const historical = this.history.get(sessionId);
    if (historical) return historical;

    // Return a live pending snapshot.
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      sessionId,
      userAId: session.userAId,
      userBId: session.userBId,
      voteA: session.voteA,
      voteB: session.voteB,
      outcome: 'pending',
      resolvedAt: null
    };
  }

  /**
   * Return whether a voting session is currently open.
   */
  isOpen(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && !session.closed;
  }

  /**
   * Return the complete vote history (all resolved sessions).
   *
   * This slice of data is consumed by the Chemistry AI model.
   */
  getVoteHistory(): Readonly<VotingResult>[] {
    return [...this.history.values()];
  }

  /**
   * Return aggregate statistics across all resolved sessions.
   *
   * Useful for the Stats page shown to users.
   */
  getStats(userId: string): {
    totalCalls: number;
    mutualMatches: number;
    heartsGiven: number;
    heartsReceived: number;
    matchRate: number;
  } {
    let totalCalls = 0;
    let mutualMatches = 0;
    let heartsGiven = 0;
    let heartsReceived = 0;

    for (const result of this.history.values()) {
      const isUserA = result.userAId === userId;
      const isUserB = result.userBId === userId;
      if (!isUserA && !isUserB) continue;

      totalCalls++;

      const myVote = isUserA ? result.voteA : result.voteB;
      const theirVote = isUserA ? result.voteB : result.voteA;

      if (myVote === 'heart') heartsGiven++;
      if (theirVote === 'heart') heartsReceived++;
      if (result.outcome === 'mutual-match') mutualMatches++;
    }

    const matchRate = totalCalls > 0 ? (mutualMatches / totalCalls) * 100 : 0;
    return { totalCalls, mutualMatches, heartsGiven, heartsReceived, matchRate };
  }

  /** Number of currently open voting sessions. */
  openSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Clear all open voting sessions (useful for testing).
   * Completed vote history is intentionally preserved so that the Chemistry AI
   * model can consume it after a test tear-down.
   */
  clear(): void {
    for (const session of this.sessions.values()) {
      clearTimeout(session.timeoutHandle);
    }
    this.sessions.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve a session: compute outcome, store in history, emit events, and
   * clean up state.
   */
  private resolveSession(session: VotingSession): void {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.timeoutHandle);
    this.sessions.delete(session.sessionId);

    const now = this.nowFn();

    // Treat a null vote as "next".
    const voteA = session.voteA ?? 'next';
    const voteB = session.voteB ?? 'next';

    // Emit timeout events for any user who did not vote.
    if (session.voteA === null) {
      this.emit('vote-timeout', session.sessionId, session.userAId);
    }
    if (session.voteB === null) {
      this.emit('vote-timeout', session.sessionId, session.userBId);
    }

    // Determine outcome.
    let outcome: VotingResult['outcome'];
    if (voteA === 'heart' && voteB === 'heart') {
      outcome = 'mutual-match';
    } else if (voteA === 'next' && voteB === 'next') {
      outcome = 'both-skipped';
    } else {
      outcome = 'one-sided';
    }

    const result: VotingResult = {
      sessionId: session.sessionId,
      userAId: session.userAId,
      userBId: session.userBId,
      voteA: session.voteA,
      voteB: session.voteB,
      outcome,
      resolvedAt: now
    };

    this.history.set(session.sessionId, result);
    this.emit('voting-closed', session.sessionId);

    // Emit outcome-specific events.
    if (outcome === 'mutual-match') {
      const chatRoomId = randomUUID();
      const matchResult: MutualMatchResult = {
        sessionId: session.sessionId,
        userAId: session.userAId,
        userBId: session.userBId,
        chatRoomId,
        resolvedAt: now
      };
      this.emit('mutual-match', matchResult);
    } else if (outcome === 'one-sided') {
      // Determine which user hearted.
      if (voteA === 'heart' && voteB === 'next') {
        // A liked B, but B skipped.  Notify B (they might reconsider).
        const fomo: FomoNotification = {
          sessionId: session.sessionId,
          recipientId: session.userBId,
          admirerId: session.userAId,
          message: 'Someone you just met liked you! 💘',
          sentAt: now
        };
        this.emit('fomo-notification', fomo);
      } else if (voteB === 'heart' && voteA === 'next') {
        // B liked A, but A skipped.  Notify A.
        const fomo: FomoNotification = {
          sessionId: session.sessionId,
          recipientId: session.userAId,
          admirerId: session.userBId,
          message: 'Someone you just met liked you! 💘',
          sentAt: now
        };
        this.emit('fomo-notification', fomo);
      }
    }
  }
}
