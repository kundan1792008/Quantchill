/**
 * MatchQueue – in-memory match queue with Redis Sorted Set semantics.
 *
 * Implements the bracket-based queue described in the Quantchill matchmaking
 * spec without requiring a live Redis connection.  The public interface is
 * identical to a Redis-backed implementation so that swapping in `ioredis`
 * later is a purely infrastructure concern.
 *
 * Queue structure mirrors: `matchqueue:{bracket}` → sorted set keyed by
 * enqueue timestamp (waitTime) so `dequeue` always pops the longest-waiting
 * user.
 *
 * Features:
 *  - O(log N) bracket lookup (sorted array insertion).
 *  - `enqueue(userId, elo)` → add to the appropriate bracket sorted set.
 *  - `dequeue(bracket)` → pop the longest-waiting user from a bracket.
 *  - `findMatch(userId)` → find the closest-ELO user within ±200 pts;
 *    radius expands by 50 every 5 seconds of waiting.
 *  - Pub/sub simulation via EventEmitter for cross-server match notifications.
 */

import { EventEmitter } from 'node:events';
import { getGlicko2Bracket, type Glicko2Bracket } from './EloService';

// ─── Types ────────────────────────────────────────────────────────────────────

/** An entry in the match queue. */
export interface QueueEntry {
  userId: string;
  elo: number;
  bracket: Glicko2Bracket;
  enqueuedAt: number;
}

/** Result returned when a match is found. */
export interface MatchPair {
  userA: QueueEntry;
  userB: QueueEntry;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Initial ELO search radius (rating points). */
const INITIAL_RADIUS = 200;
/** Radius expansion per time window. */
const RADIUS_STEP = 50;
/** Time window (ms) after which the search radius expands. */
const EXPAND_INTERVAL_MS = 5_000;
/** Maximum ELO search radius before accepting any bracket partner. */
const MAX_RADIUS = 600;

// ─── MatchQueue ───────────────────────────────────────────────────────────────

/**
 * MatchQueue – bracket-aware match queue.
 *
 * Internally each bracket maps to a sorted array of QueueEntry objects ordered
 * ascending by `enqueuedAt` (longest-waiting first when shifted from the front).
 */
export class MatchQueue extends EventEmitter {
  /** Bracket → sorted array of QueueEntry (ascending enqueuedAt). */
  private readonly queues = new Map<Glicko2Bracket, QueueEntry[]>();

  /** userId → QueueEntry for O(1) membership checks. */
  private readonly members = new Map<string, QueueEntry>();

  constructor() {
    super();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getQueue(bracket: Glicko2Bracket): QueueEntry[] {
    if (!this.queues.has(bracket)) {
      this.queues.set(bracket, []);
    }
    return this.queues.get(bracket)!;
  }

  /**
   * Binary-search insert to maintain ascending `enqueuedAt` order in O(log N).
   */
  private insertSorted(queue: QueueEntry[], entry: QueueEntry): void {
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (queue[mid]!.enqueuedAt <= entry.enqueuedAt) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    queue.splice(lo, 0, entry);
  }

  /** Remove an entry from a bracket queue by userId. */
  private removeFromQueue(bracket: Glicko2Bracket, userId: string): boolean {
    const queue = this.getQueue(bracket);
    const idx = queue.findIndex((e) => e.userId === userId);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    return true;
  }

  /**
   * Compute the effective ELO search radius for a queued user.
   *
   * Radius expands by RADIUS_STEP every EXPAND_INTERVAL_MS of wait time,
   * capped at MAX_RADIUS.
   */
  private effectiveRadius(enqueuedAt: number, now = Date.now()): number {
    const waitMs = Math.max(0, now - enqueuedAt);
    const expansions = Math.floor(waitMs / EXPAND_INTERVAL_MS);
    return Math.min(MAX_RADIUS, INITIAL_RADIUS + expansions * RADIUS_STEP);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Add a user to the appropriate ELO bracket queue.
   * If the user is already queued, their entry is refreshed.
   */
  enqueue(userId: string, elo: number): QueueEntry {
    // Remove existing entry if re-queuing.
    if (this.members.has(userId)) {
      this.remove(userId);
    }

    const bracket = getGlicko2Bracket(elo);
    const entry: QueueEntry = { userId, elo, bracket, enqueuedAt: Date.now() };

    this.insertSorted(this.getQueue(bracket), entry);
    this.members.set(userId, entry);

    this.emit('enqueued', entry);
    return entry;
  }

  /**
   * Remove a specific user from the queue (e.g., on disconnect).
   * Returns true if the user was found and removed.
   */
  remove(userId: string): boolean {
    const entry = this.members.get(userId);
    if (!entry) return false;
    this.removeFromQueue(entry.bracket, userId);
    this.members.delete(userId);
    this.emit('removed', entry);
    return true;
  }

  /**
   * Pop the longest-waiting user from a bracket (O(1) shift).
   * Returns null if the bracket queue is empty.
   */
  dequeue(bracket: Glicko2Bracket): QueueEntry | null {
    const queue = this.getQueue(bracket);
    const entry = queue.shift() ?? null;
    if (entry) {
      this.members.delete(entry.userId);
      this.emit('dequeued', entry);
    }
    return entry;
  }

  /**
   * Find the best ELO match for a queued user.
   *
   * Algorithm:
   *  1. Compute the user's current effective radius (expands over time).
   *  2. Scan the same bracket first for users within ±radius ELO.
   *  3. If no match found, scan adjacent brackets within the same radius.
   *  4. Among candidates, pick the one with the smallest ELO difference.
   *
   * Both matched users are removed from the queue.
   * Emits `match-found` with the MatchPair.
   *
   * @returns MatchPair if a match was found, null otherwise.
   */
  findMatch(userId: string): MatchPair | null {
    const entry = this.members.get(userId);
    if (!entry) return null;

    const now = Date.now();
    const radius = this.effectiveRadius(entry.enqueuedAt, now);

    // Gather all queue entries across all brackets (excluding self).
    const allEntries: QueueEntry[] = [];
    for (const queue of this.queues.values()) {
      for (const e of queue) {
        if (e.userId !== userId) allEntries.push(e);
      }
    }

    // Filter to those within the ELO radius.
    const candidates = allEntries.filter(
      (e) => Math.abs(e.elo - entry.elo) <= radius
    );

    if (candidates.length === 0) return null;

    // Pick the closest by ELO delta.
    candidates.sort((a, b) => Math.abs(a.elo - entry.elo) - Math.abs(b.elo - entry.elo));
    const partner = candidates[0]!;

    // Remove both from the queue.
    this.remove(entry.userId);
    this.remove(partner.userId);

    const pair: MatchPair = { userA: entry, userB: partner };
    this.emit('match-found', pair);
    return pair;
  }

  /** Return the current queue size for a bracket. */
  queueSize(bracket: Glicko2Bracket): number {
    return this.getQueue(bracket).length;
  }

  /** Return total users across all brackets. */
  totalQueued(): number {
    return this.members.size;
  }

  /** Check whether a user is currently in the queue. */
  isQueued(userId: string): boolean {
    return this.members.has(userId);
  }

  /** Return a read-only snapshot of a bracket's queue. */
  peekQueue(bracket: Glicko2Bracket): Readonly<QueueEntry>[] {
    return [...this.getQueue(bracket)];
  }

  /** Clear all queues (useful for testing). */
  clear(): void {
    this.queues.clear();
    this.members.clear();
  }
}
