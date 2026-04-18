/**
 * SpeedDatingQueue – timed matchmaking queue for the Speed Dating mini-game.
 *
 * Mirrors Redis Sorted Set semantics (scores = enqueue timestamps) via an
 * in-memory implementation so that dropping in `ioredis` later is a purely
 * infrastructure concern.
 *
 * Rules:
 *  - Users are matched within ±5 years of age.
 *  - A 10-second countdown fires before the call is connected; the caller may
 *    cancel penalty-free within the first 5 seconds.
 *  - At most MAX_CONCURRENT_PAIRS (100) active pairs per server instance.
 *  - After a call ends, both users enter a 30-second cooldown before they may
 *    re-enter the queue.
 *  - Happy Hour (peak: 20:00–22:00 local hour) doubles the effective match
 *    radius to ±10 years.
 *  - Theme Night: if a theme is set, users are only matched against others who
 *    chose the same theme.
 *
 * Events emitted:
 *  - `enqueued`        (entry: SpeedQueueEntry)
 *  - `removed`         (entry: SpeedQueueEntry)
 *  - `countdown-start` (userIds: [string, string], roomId: string, endsAt: number)
 *  - `match-ready`     (pair: SpeedMatchPair)  – fires after the 10 s countdown
 *  - `match-cancelled` (roomId: string, cancelledBy: string)
 *  - `cooldown-start`  (userId: string, expiresAt: number)
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum age gap (years) between matched users during normal hours. */
const NORMAL_AGE_RADIUS = 5;

/** Maximum age gap during Happy Hour (20:00 – 22:00). */
const HAPPY_HOUR_AGE_RADIUS = 10;

/** Happy Hour start hour (local, 24-hour clock). */
const HAPPY_HOUR_START = 20;

/** Happy Hour end hour (exclusive). */
const HAPPY_HOUR_END = 22;

/** Countdown duration before the call is connected (ms). */
const COUNTDOWN_MS = 10_000;

/** Penalty-free cancellation window from countdown start (ms). */
const CANCEL_GRACE_MS = 5_000;

/** Maximum active pairs before new matches are deferred. */
const MAX_CONCURRENT_PAIRS = 100;

/** Cooldown between consecutive calls (ms). */
const COOLDOWN_DURATION_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Selectable themes for Theme Night events. */
export type SpeedDatingTheme = 'travel' | 'music' | 'tech' | 'fitness' | 'food' | 'gaming' | null;

/** A user entry in the speed-dating queue. */
export interface SpeedQueueEntry {
  userId: string;
  age: number;
  theme: SpeedDatingTheme;
  enqueuedAt: number;
}

/** A matched pair returned when two users are ready to connect. */
export interface SpeedMatchPair {
  roomId: string;
  userA: SpeedQueueEntry;
  userB: SpeedQueueEntry;
  matchedAt: number;
}

/** Internal state for a pending countdown room. */
interface CountdownRoom {
  roomId: string;
  pair: SpeedMatchPair;
  countdownHandle: ReturnType<typeof setTimeout>;
  startedAt: number;
  cancelled: boolean;
}

/** Reason a user was removed from the queue. */
export type RemoveReason = 'manual' | 'matched' | 'timeout';

// ─── SpeedDatingQueue ─────────────────────────────────────────────────────────

/**
 * SpeedDatingQueue manages the lifecycle of users waiting for a speed date,
 * from queue entry through the 10-second countdown to call start.
 */
export class SpeedDatingQueue extends EventEmitter {
  /** Pending queue: userId → SpeedQueueEntry, ordered by enqueuedAt. */
  private readonly queue: Map<string, SpeedQueueEntry> = new Map();

  /** Countdown rooms keyed by roomId. */
  private readonly countdowns: Map<string, CountdownRoom> = new Map();

  /** Active pairs (roomId → pair). Counts toward MAX_CONCURRENT_PAIRS. */
  private readonly activePairs: Map<string, SpeedMatchPair> = new Map();

  /** userId → cooldown expiry timestamp (ms). */
  private readonly cooldowns: Map<string, number> = new Map();

  /** userId → roomId of the countdown they are in. */
  private readonly userCountdownRoom: Map<string, string> = new Map();

  /**
   * Injectable clock (returns ms since epoch). Defaults to `Date.now`.
   * Pass a custom function in tests to control time without fake-timer
   * overhead.
   */
  private readonly nowFn: () => number;

  constructor(nowFn: () => number = Date.now) {
    super();
    this.nowFn = nowFn;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Add a user to the speed-dating queue.
   *
   * If the user is already queued, their entry is refreshed with the new
   * parameters (age / theme).  Returns the new entry.
   *
   * Throws if the user is currently in cooldown.
   */
  enqueue(userId: string, age: number, theme: SpeedDatingTheme = null): SpeedQueueEntry {
    const now = this.nowFn();

    // Cooldown check.
    const cooldownExpiry = this.cooldowns.get(userId);
    if (cooldownExpiry !== undefined && now < cooldownExpiry) {
      throw new Error(
        `User ${userId} is in cooldown until ${new Date(cooldownExpiry).toISOString()}`
      );
    }
    if (cooldownExpiry !== undefined && now >= cooldownExpiry) {
      this.cooldowns.delete(userId);
    }

    // Prevent double-queueing without penalty.
    if (this.queue.has(userId)) {
      this.remove(userId);
    }

    const entry: SpeedQueueEntry = { userId, age, theme, enqueuedAt: now };
    this.queue.set(userId, entry);
    this.emit('enqueued', entry);

    // Attempt to pair this user immediately.
    this.tryMatch(userId);

    return entry;
  }

  /**
   * Remove a user from the queue manually (e.g. on disconnect).
   *
   * If they are mid-countdown, the countdown is cancelled.
   * Returns true if the user was found and removed.
   */
  remove(userId: string): boolean {
    const entry = this.queue.get(userId);
    if (!entry) return false;

    this.queue.delete(userId);
    this.emit('removed', entry);

    // Cancel any in-progress countdown for this user.
    const roomId = this.userCountdownRoom.get(userId);
    if (roomId) {
      this.cancelCountdown(roomId, userId);
    }

    return true;
  }

  /**
   * Cancel a countdown room.
   *
   * If called within the grace window (first 5 s) there is no penalty for
   * either user.  After the grace window, the cancelling user receives a
   * 30-second cooldown.
   *
   * Returns true if the room was found and cancelled.
   */
  cancelCountdown(roomId: string, cancelledBy: string): boolean {
    const room = this.countdowns.get(roomId);
    if (!room || room.cancelled) return false;

    room.cancelled = true;
    clearTimeout(room.countdownHandle);
    this.countdowns.delete(roomId);

    const now = this.nowFn();
    const elapsed = now - room.startedAt;
    const withinGrace = elapsed <= CANCEL_GRACE_MS;

    // Penalise the canceller if they bailed after the grace window.
    if (!withinGrace) {
      this.applyCooldown(cancelledBy, now);
    }

    // Re-queue the other participant (no penalty).
    const pair = room.pair;
    const otherId =
      pair.userA.userId === cancelledBy ? pair.userB.userId : pair.userA.userId;
    const otherEntry =
      pair.userA.userId === cancelledBy ? pair.userB : pair.userA;

    this.userCountdownRoom.delete(cancelledBy);
    this.userCountdownRoom.delete(otherId);

    // Silently re-enqueue the innocent party.
    const reEntry: SpeedQueueEntry = {
      ...otherEntry,
      enqueuedAt: now
    };
    this.queue.set(otherId, reEntry);
    this.emit('enqueued', reEntry);

    this.emit('match-cancelled', roomId, cancelledBy);
    return true;
  }

  /**
   * Mark a call as ended for a given roomId.
   *
   * Removes the pair from active pairs and applies the post-call cooldown to
   * both users.
   */
  endCall(roomId: string): boolean {
    const pair = this.activePairs.get(roomId);
    if (!pair) return false;

    this.activePairs.delete(roomId);
    const now = this.nowFn();
    this.applyCooldown(pair.userA.userId, now);
    this.applyCooldown(pair.userB.userId, now);
    return true;
  }

  /**
   * Whether a user is currently in the queue (not counting mid-countdown).
   */
  isQueued(userId: string): boolean {
    return this.queue.has(userId);
  }

  /**
   * Whether a user is currently in a cooldown period.
   */
  isInCooldown(userId: string): boolean {
    const expiry = this.cooldowns.get(userId);
    if (expiry === undefined) return false;
    if (this.nowFn() >= expiry) {
      this.cooldowns.delete(userId);
      return false;
    }
    return true;
  }

  /**
   * Returns the cooldown expiry timestamp for a user, or null if none.
   */
  cooldownExpiry(userId: string): number | null {
    const expiry = this.cooldowns.get(userId);
    if (expiry === undefined) return null;
    if (this.nowFn() >= expiry) {
      this.cooldowns.delete(userId);
      return null;
    }
    return expiry;
  }

  /** Total number of users waiting in the queue. */
  queueSize(): number {
    return this.queue.size;
  }

  /** Number of active call pairs right now. */
  activePairCount(): number {
    return this.activePairs.size;
  }

  /** Number of pending countdown rooms. */
  countdownCount(): number {
    return this.countdowns.size;
  }

  /** Read-only snapshot of the current queue (ordered by enqueuedAt). */
  peekQueue(): Readonly<SpeedQueueEntry>[] {
    return [...this.queue.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  /** Clear all state (useful for testing). */
  clear(): void {
    for (const room of this.countdowns.values()) {
      clearTimeout(room.countdownHandle);
    }
    this.queue.clear();
    this.countdowns.clear();
    this.activePairs.clear();
    this.cooldowns.clear();
    this.userCountdownRoom.clear();
  }

  // ── Matching logic ────────────────────────────────────────────────────────

  /**
   * Attempt to find a match for a newly-queued user.
   *
   * Matching criteria:
   *  1. Same theme (or both null for any theme).
   *  2. Age within the current age radius (5 yr normal, 10 yr during Happy Hour).
   *  3. Server capacity not exceeded.
   *
   * Among eligible candidates, the user who has been waiting longest is
   * preferred.
   */
  private tryMatch(userId: string): void {
    if (this.activePairs.size >= MAX_CONCURRENT_PAIRS) return;

    const entry = this.queue.get(userId);
    if (!entry) return;

    const now = this.nowFn();
    const ageRadius = this.isHappyHour(now) ? HAPPY_HOUR_AGE_RADIUS : NORMAL_AGE_RADIUS;

    // Find eligible candidates.
    const candidates: SpeedQueueEntry[] = [];
    for (const candidate of this.queue.values()) {
      if (candidate.userId === userId) continue;
      if (!this.themeCompatible(entry.theme, candidate.theme)) continue;
      if (Math.abs(candidate.age - entry.age) > ageRadius) continue;
      // Ensure candidate is not already in a countdown.
      if (this.userCountdownRoom.has(candidate.userId)) continue;
      candidates.push(candidate);
    }

    if (candidates.length === 0) return;

    // Pick the longest-waiting candidate.
    candidates.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    const partner = candidates[0]!;

    // Remove both from queue.
    this.queue.delete(userId);
    this.queue.delete(partner.userId);

    const roomId = randomUUID();
    const pair: SpeedMatchPair = {
      roomId,
      userA: entry,
      userB: partner,
      matchedAt: now
    };

    this.startCountdown(pair);
  }

  /**
   * Start the 10-second countdown for a matched pair.
   * Emits `countdown-start` immediately and `match-ready` after 10 s.
   */
  private startCountdown(pair: SpeedMatchPair): void {
    const now = this.nowFn();
    const endsAt = now + COUNTDOWN_MS;

    const countdownHandle = setTimeout(() => {
      this.finaliseMatch(pair.roomId);
    }, COUNTDOWN_MS);

    const room: CountdownRoom = {
      roomId: pair.roomId,
      pair,
      countdownHandle,
      startedAt: now,
      cancelled: false
    };

    this.countdowns.set(pair.roomId, room);
    this.userCountdownRoom.set(pair.userA.userId, pair.roomId);
    this.userCountdownRoom.set(pair.userB.userId, pair.roomId);

    this.emit('countdown-start', [pair.userA.userId, pair.userB.userId], pair.roomId, endsAt);
  }

  /**
   * Called when the 10-second countdown elapses without cancellation.
   * Moves the pair from pending countdown to active pairs.
   */
  private finaliseMatch(roomId: string): void {
    const room = this.countdowns.get(roomId);
    if (!room || room.cancelled) return;

    this.countdowns.delete(roomId);
    this.userCountdownRoom.delete(room.pair.userA.userId);
    this.userCountdownRoom.delete(room.pair.userB.userId);

    this.activePairs.set(roomId, room.pair);
    this.emit('match-ready', room.pair);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Apply a post-call cooldown to a user. */
  private applyCooldown(userId: string, now: number): void {
    const expiresAt = now + COOLDOWN_DURATION_MS;
    this.cooldowns.set(userId, expiresAt);
    this.emit('cooldown-start', userId, expiresAt);
  }

  /**
   * Returns true if the current hour (UTC) falls within Happy Hour
   * (20:00 – 22:00).
   */
  private isHappyHour(nowMs: number): boolean {
    const hour = new Date(nowMs).getUTCHours();
    return hour >= HAPPY_HOUR_START && hour < HAPPY_HOUR_END;
  }

  /**
   * Two themes are compatible when both are null (any theme) or equal.
   */
  private themeCompatible(a: SpeedDatingTheme, b: SpeedDatingTheme): boolean {
    if (a === null || b === null) return true;
    return a === b;
  }
}
