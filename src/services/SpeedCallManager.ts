/**
 * SpeedCallManager – WebRTC call session manager for 60-second speed dates.
 *
 * Responsibilities:
 *  1. Accept a matched pair from SpeedDatingQueue and open a signaling room.
 *  2. Enforce a hard 60-second call duration; emit `warning` at 10 s remaining.
 *  3. Auto-disconnect both peers when the timer reaches zero.
 *  4. Monitor connection quality; issue a re-match token when quality drops to
 *     `disconnected` before the call ends naturally.
 *  5. Relay WebRTC offer / answer / ICE-candidate messages between peers.
 *
 * Events emitted:
 *  - `call-started`     (session: CallSession)
 *  - `signal`           (msg: SpeedSignalingMessage)    – forwarded SDP/ICE
 *  - `call-warning`     (sessionId: string, remainingMs: number)
 *  - `call-ended`       (sessionId: string, reason: CallEndReason)
 *  - `rematch-token`    (userId: string, token: string)  – one per user on drop
 *  - `quality-changed`  (sessionId: string, quality: CallQuality)
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SpeedMatchPair } from './SpeedDatingQueue';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard call duration in milliseconds. */
export const CALL_DURATION_MS = 60_000;

/** Remaining time at which a warning event is emitted (ms). */
const WARNING_THRESHOLD_MS = 10_000;

/** Interval at which quality is re-evaluated (ms). */
const QUALITY_CHECK_INTERVAL_MS = 5_000;

/** Number of consecutive poor-quality checks before treating as disconnected. */
const DISCONNECT_THRESHOLD = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Connection quality levels reported by the quality monitor. */
export type CallQuality = 'good' | 'medium' | 'poor' | 'disconnected';

/** Reason a call session ended. */
export type CallEndReason =
  | 'timer'          // 60 s elapsed
  | 'user-ended'     // one peer ended the call
  | 'disconnected';  // quality monitor detected full disconnect

/** A WebRTC signaling message relayed by SpeedCallManager. */
export interface SpeedSignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  fromUserId: string;
  toUserId: string;
  payload: unknown;
  sessionId: string;
}

/** Quality report submitted by a peer (e.g. from RTCPeerConnection stats). */
export interface QualityReport {
  sessionId: string;
  userId: string;
  quality: CallQuality;
}

/** Public snapshot of an active call session. */
export interface CallSession {
  sessionId: string;
  roomId: string;
  userAId: string;
  userBId: string;
  startedAt: number;
  endsAt: number;
  quality: CallQuality;
}

/** Full internal state for an active session. */
interface SessionState {
  sessionId: string;
  pair: SpeedMatchPair;
  startedAt: number;
  endsAt: number;
  callTimer: ReturnType<typeof setTimeout>;
  warningTimer: ReturnType<typeof setTimeout>;
  qualityTimer: ReturnType<typeof setInterval>;
  quality: CallQuality;
  offerReceived: boolean;
  answerReceived: boolean;
  /** Count of consecutive poor-quality reports per userId. */
  poorCounts: Map<string, number>;
  ended: boolean;
}

// ─── SpeedCallManager ─────────────────────────────────────────────────────────

/**
 * SpeedCallManager maintains the lifecycle of every active 60-second call.
 *
 * Construct with an optional `nowFn` for deterministic testing.
 */
export class SpeedCallManager extends EventEmitter {
  /** Active sessions keyed by sessionId. */
  private readonly sessions = new Map<string, SessionState>();

  /** roomId → sessionId (fast lookup from SpeedDatingQueue room ids). */
  private readonly roomIndex = new Map<string, string>();

  /** sessionId → token for lightweight credential verification. */
  private readonly tokens = new Map<string, string>();

  private readonly nowFn: () => number;

  constructor(nowFn: () => number = Date.now) {
    super();
    this.nowFn = nowFn;
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  /**
   * Open a new call session for a matched pair.
   *
   * Schedules the warning timer (at 50 s) and the hard end-of-call timer
   * (at 60 s).  Returns a `CallSession` snapshot with the session credentials.
   */
  startSession(pair: SpeedMatchPair): CallSession {
    const sessionId = randomUUID();
    const token = randomUUID();
    const now = this.nowFn();
    const endsAt = now + CALL_DURATION_MS;

    const warningTimer = setTimeout(() => {
      this.emitWarning(sessionId);
    }, CALL_DURATION_MS - WARNING_THRESHOLD_MS);

    const callTimer = setTimeout(() => {
      this.endSession(sessionId, 'timer');
    }, CALL_DURATION_MS);

    const qualityTimer = setInterval(() => {
      this.checkQualityTimeout(sessionId);
    }, QUALITY_CHECK_INTERVAL_MS);

    const state: SessionState = {
      sessionId,
      pair,
      startedAt: now,
      endsAt,
      callTimer,
      warningTimer,
      qualityTimer,
      quality: 'good',
      offerReceived: false,
      answerReceived: false,
      poorCounts: new Map([
        [pair.userA.userId, 0],
        [pair.userB.userId, 0]
      ]),
      ended: false
    };

    this.sessions.set(sessionId, state);
    this.roomIndex.set(pair.roomId, sessionId);
    this.tokens.set(sessionId, token);

    const snapshot = this.buildSnapshot(state);
    this.emit('call-started', snapshot);
    return snapshot;
  }

  /**
   * End a call session.
   *
   * Clears all timers, removes session state, and emits `call-ended`.
   * Returns false if the session does not exist or was already ended.
   */
  endSession(sessionId: string, reason: CallEndReason = 'user-ended'): boolean {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return false;

    state.ended = true;
    clearTimeout(state.callTimer);
    clearTimeout(state.warningTimer);
    clearInterval(state.qualityTimer);

    this.sessions.delete(sessionId);
    this.roomIndex.delete(state.pair.roomId);
    this.tokens.delete(sessionId);

    this.emit('call-ended', sessionId, reason);
    return true;
  }

  /**
   * Relay a WebRTC signaling message between peers in a session.
   *
   * Validates sender / recipient membership.  Tracks offer and answer receipt
   * to confirm that the WebRTC handshake completed.
   *
   * @returns true if the message was accepted and forwarded.
   */
  relay(msg: SpeedSignalingMessage): boolean {
    const state = this.sessions.get(msg.sessionId);
    if (!state || state.ended) return false;

    const { userA, userB } = state.pair;
    const participants = [userA.userId, userB.userId];

    if (!participants.includes(msg.fromUserId)) return false;
    if (!participants.includes(msg.toUserId)) return false;
    if (msg.fromUserId === msg.toUserId) return false;

    if (msg.type === 'offer') state.offerReceived = true;
    if (msg.type === 'answer') state.answerReceived = true;

    this.emit('signal', msg);
    return true;
  }

  /**
   * Accept a quality report from a peer.
   *
   * If both peers report `disconnected` consecutively, the call is ended early
   * and each user receives a re-match token.
   */
  reportQuality(report: QualityReport): void {
    const state = this.sessions.get(report.sessionId);
    if (!state || state.ended) return;

    const { userA, userB } = state.pair;
    const participants = [userA.userId, userB.userId];
    if (!participants.includes(report.userId)) return;

    // Track consecutive poor/disconnected reports for this user.
    const prevCount = state.poorCounts.get(report.userId) ?? 0;
    const newCount =
      report.quality === 'poor' || report.quality === 'disconnected'
        ? prevCount + 1
        : 0;
    state.poorCounts.set(report.userId, newCount);

    // Update overall session quality to the worse of the two.
    const otherUserId = report.userId === userA.userId ? userB.userId : userA.userId;
    const otherCount = state.poorCounts.get(otherUserId) ?? 0;

    const prevQuality = state.quality;
    state.quality = this.worstQuality(report.quality, this.qualityFromCount(otherCount));

    if (state.quality !== prevQuality) {
      this.emit('quality-changed', report.sessionId, state.quality);
    }

    // Both users have been consistently poor / disconnected.
    if (
      newCount >= DISCONNECT_THRESHOLD &&
      otherCount >= DISCONNECT_THRESHOLD &&
      report.quality === 'disconnected'
    ) {
      this.issueRematchTokens(state);
      this.endSession(report.sessionId, 'disconnected');
    }
  }

  /** Verify that a token is valid for a given session. */
  verifyToken(sessionId: string, token: string): boolean {
    return this.tokens.get(sessionId) === token;
  }

  /** Return whether a session is active. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Look up a sessionId by its originating roomId. */
  sessionForRoom(roomId: string): string | null {
    return this.roomIndex.get(roomId) ?? null;
  }

  /** Return a public snapshot of a session. */
  getSession(sessionId: string): Readonly<CallSession> | null {
    const state = this.sessions.get(sessionId);
    return state ? this.buildSnapshot(state) : null;
  }

  /** Number of active sessions. */
  activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Return remaining call time in milliseconds for a session.
   * Returns 0 if the session has ended or does not exist.
   */
  remainingMs(sessionId: string): number {
    const state = this.sessions.get(sessionId);
    if (!state) return 0;
    return Math.max(0, state.endsAt - this.nowFn());
  }

  /** Tear down all sessions (useful in tests). */
  clear(): void {
    for (const state of this.sessions.values()) {
      clearTimeout(state.callTimer);
      clearTimeout(state.warningTimer);
      clearInterval(state.qualityTimer);
    }
    this.sessions.clear();
    this.roomIndex.clear();
    this.tokens.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private emitWarning(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;
    this.emit('call-warning', sessionId, WARNING_THRESHOLD_MS);
  }

  /**
   * Periodic quality check: if quality has been `disconnected` for the full
   * quality check interval with no reports, treat it as a drop.
   */
  private checkQualityTimeout(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;

    if (state.quality !== 'disconnected') return;

    // Both users have had zero updates — silent drop.
    const counts = [...state.poorCounts.values()];
    if (counts.every((c) => c >= DISCONNECT_THRESHOLD)) {
      this.issueRematchTokens(state);
      this.endSession(sessionId, 'disconnected');
    }
  }

  /** Issue a re-match token to each participant and emit the events. */
  private issueRematchTokens(state: SessionState): void {
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    this.emit('rematch-token', state.pair.userA.userId, tokenA);
    this.emit('rematch-token', state.pair.userB.userId, tokenB);
  }

  /** Map consecutive-poor count to a quality level. */
  private qualityFromCount(count: number): CallQuality {
    if (count === 0) return 'good';
    if (count === 1) return 'medium';
    if (count === 2) return 'poor';
    return 'disconnected';
  }

  /** Return the worse of two quality levels. */
  private worstQuality(a: CallQuality, b: CallQuality): CallQuality {
    const rank: Record<CallQuality, number> = {
      good: 0,
      medium: 1,
      poor: 2,
      disconnected: 3
    };
    return rank[a] >= rank[b] ? a : b;
  }

  /** Build a public CallSession snapshot from internal state. */
  private buildSnapshot(state: SessionState): CallSession {
    return {
      sessionId: state.sessionId,
      roomId: state.pair.roomId,
      userAId: state.pair.userA.userId,
      userBId: state.pair.userB.userId,
      startedAt: state.startedAt,
      endsAt: state.endsAt,
      quality: state.quality
    };
  }
}
