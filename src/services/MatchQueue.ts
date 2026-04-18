/**
 * MatchQueue – Redis-compatible sorted-set bracket queue for Quantchill matchmaking.
 *
 * Each ELO bracket has its own sorted set keyed `matchqueue:{bracket}` where the
 * **score** is the user's wait-time start timestamp (ms). Sorting by score gives
 * O(log N) lookup of the longest-waiting user. A second sorted set keyed
 * `matchqueue:{bracket}:elo` stores the same users scored by their ELO rating,
 * enabling `findMatch` to discover the closest-rated peer with a single
 * `ZRANGEBYSCORE` call.
 *
 * The match radius starts at ±200 ELO and expands by +50 every 5 seconds a user
 * has been waiting, preventing indefinite stalls in sparse brackets.
 *
 * A pluggable `SortedSetStore` abstracts the underlying engine so that an
 * `IORedis`-backed store can be swapped in for production without touching the
 * business logic. Pub/sub notifications are emitted through a lightweight
 * `EventEmitter` so that a Redis pub/sub adapter can forward them across servers.
 */

import { EventEmitter } from 'node:events';
import { getEloBracket, EloBracket } from './EloRatingService';

/** A member of a sorted set. */
export interface SortedSetMember {
  member: string;
  score: number;
}

/**
 * Minimal interface implemented by an in-memory and a Redis-backed store.
 * Methods mirror the Redis commands they're named after.
 */
export interface SortedSetStore {
  /** ZADD key score member – insert or update a member. */
  zadd(key: string, score: number, member: string): void;
  /** ZREM key member – remove a member; returns true if present. */
  zrem(key: string, member: string): boolean;
  /** ZSCORE key member – return a member's score or null. */
  zscore(key: string, member: string): number | null;
  /** ZCARD key – return the cardinality of the set. */
  zcard(key: string): number;
  /** ZRANGE key start stop – return members ordered by ascending score. */
  zrange(key: string, start: number, stop: number): SortedSetMember[];
  /** ZPOPMIN key – pop the lowest-scored member atomically. */
  zpopmin(key: string): SortedSetMember | null;
  /** ZRANGEBYSCORE key min max – return members with min ≤ score ≤ max. */
  zrangebyscore(key: string, min: number, max: number): SortedSetMember[];
  /** Remove every sorted set – used for tests. */
  flushall(): void;
}

/** Default in-memory store. */
export class InMemorySortedSetStore implements SortedSetStore {
  private readonly sets = new Map<string, Map<string, number>>();

  private getSet(key: string): Map<string, number> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Map();
      this.sets.set(key, s);
    }
    return s;
  }

  zadd(key: string, score: number, member: string): void {
    this.getSet(key).set(member, score);
  }

  zrem(key: string, member: string): boolean {
    const s = this.sets.get(key);
    if (!s) return false;
    return s.delete(member);
  }

  zscore(key: string, member: string): number | null {
    const s = this.sets.get(key);
    if (!s || !s.has(member)) return null;
    return s.get(member) as number;
  }

  zcard(key: string): number {
    return this.sets.get(key)?.size ?? 0;
  }

  zrange(key: string, start: number, stop: number): SortedSetMember[] {
    const s = this.sets.get(key);
    if (!s) return [];
    const sorted = Array.from(s.entries())
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
    return sorted.slice(start, end);
  }

  zpopmin(key: string): SortedSetMember | null {
    const s = this.sets.get(key);
    if (!s || s.size === 0) return null;
    const [first] = this.zrange(key, 0, 0);
    if (!first) return null;
    s.delete(first.member);
    return first;
  }

  zrangebyscore(key: string, min: number, max: number): SortedSetMember[] {
    const s = this.sets.get(key);
    if (!s) return [];
    return Array.from(s.entries())
      .filter(([, score]) => score >= min && score <= max)
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score);
  }

  flushall(): void {
    this.sets.clear();
  }
}

/** Public shape of a queued user. */
export interface QueuedUser {
  userId: string;
  elo: number;
  bracket: EloBracket;
  enqueuedAt: number;
}

/** Configuration for `MatchQueue`. */
export interface MatchQueueOptions {
  store?: SortedSetStore;
  emitter?: EventEmitter;
  /** Base search radius in ELO points. Default 200. */
  baseRadius?: number;
  /** ELO radius expansion per interval (default +50). */
  radiusIncrement?: number;
  /** Interval (ms) between expansions. Default 5000. */
  radiusIntervalMs?: number;
  /** Maximum radius. Default 1000. */
  maxRadius?: number;
  /** Clock override, used for deterministic tests. */
  now?: () => number;
}

/** Event payloads emitted on the queue event bus. */
export interface MatchQueueEvents {
  enqueue: QueuedUser;
  dequeue: QueuedUser;
  match: { a: QueuedUser; b: QueuedUser; bracket: EloBracket };
}

function bracketKey(bracket: EloBracket): string {
  return `matchqueue:${bracket}`;
}

function bracketEloKey(bracket: EloBracket): string {
  return `matchqueue:${bracket}:elo`;
}

/**
 * High-performance bracket queue.
 *
 * All writes touch two sorted sets (wait-time + ELO) atomically through the
 * `SortedSetStore`, so a Redis-backed store would execute both in a single
 * `MULTI` pipeline for crash-consistency.
 */
export class MatchQueue {
  private readonly store: SortedSetStore;
  private readonly emitter: EventEmitter;
  private readonly baseRadius: number;
  private readonly radiusIncrement: number;
  private readonly radiusIntervalMs: number;
  private readonly maxRadius: number;
  private readonly now: () => number;
  private readonly metadata = new Map<string, QueuedUser>();

  constructor(options: MatchQueueOptions = {}) {
    this.store = options.store ?? new InMemorySortedSetStore();
    this.emitter = options.emitter ?? new EventEmitter();
    this.baseRadius = options.baseRadius ?? 200;
    this.radiusIncrement = options.radiusIncrement ?? 50;
    this.radiusIntervalMs = options.radiusIntervalMs ?? 5000;
    this.maxRadius = options.maxRadius ?? 1000;
    this.now = options.now ?? Date.now;
  }

  /** Subscribe to queue events. */
  on<K extends keyof MatchQueueEvents>(
    event: K,
    listener: (payload: MatchQueueEvents[K]) => void
  ): void {
    this.emitter.on(event, listener);
  }

  /** Unsubscribe from queue events. */
  off<K extends keyof MatchQueueEvents>(
    event: K,
    listener: (payload: MatchQueueEvents[K]) => void
  ): void {
    this.emitter.off(event, listener);
  }

  /** Enqueue a user into the bracket sorted set. */
  enqueue(userId: string, elo: number): QueuedUser {
    const bracket = getEloBracket(elo);
    const enqueuedAt = this.now();
    this.store.zadd(bracketKey(bracket), enqueuedAt, userId);
    this.store.zadd(bracketEloKey(bracket), elo, userId);
    const record: QueuedUser = { userId, elo, bracket, enqueuedAt };
    this.metadata.set(userId, record);
    this.emitter.emit('enqueue', record);
    return record;
  }

  /** Dequeue the longest-waiting user from a specific bracket. */
  dequeue(bracket: EloBracket): QueuedUser | null {
    const head = this.store.zpopmin(bracketKey(bracket));
    if (!head) return null;
    this.store.zrem(bracketEloKey(bracket), head.member);
    const record = this.metadata.get(head.member);
    this.metadata.delete(head.member);
    const resolved: QueuedUser = record ?? {
      userId: head.member,
      elo: 0,
      bracket,
      enqueuedAt: head.score
    };
    this.emitter.emit('dequeue', resolved);
    return resolved;
  }

  /** Remove a user from whatever bracket they are in. */
  remove(userId: string): boolean {
    const record = this.metadata.get(userId);
    if (!record) return false;
    this.store.zrem(bracketKey(record.bracket), userId);
    this.store.zrem(bracketEloKey(record.bracket), userId);
    this.metadata.delete(userId);
    return true;
  }

  /** Return the current size of a bracket queue. */
  size(bracket: EloBracket): number {
    return this.store.zcard(bracketKey(bracket));
  }

  /** Return a snapshot of a user's queue record. */
  getRecord(userId: string): QueuedUser | null {
    const r = this.metadata.get(userId);
    return r ? { ...r } : null;
  }

  /** Return the current search radius for a waiting user. */
  currentRadius(userId: string): number {
    const record = this.metadata.get(userId);
    if (!record) return this.baseRadius;
    const waitedMs = Math.max(0, this.now() - record.enqueuedAt);
    const expansions = Math.floor(waitedMs / this.radiusIntervalMs);
    return Math.min(this.maxRadius, this.baseRadius + expansions * this.radiusIncrement);
  }

  /**
   * Find the closest-ELO peer of `userId` within the dynamic radius.
   *
   * Returns `null` when no candidate is available. The returned record is *not*
   * automatically removed from the queue – callers should call `remove()` on
   * both sides after accepting the match so that `findMatch` can be used as a
   * non-destructive probe for candidate previews.
   */
  findMatch(userId: string): QueuedUser | null {
    const record = this.metadata.get(userId);
    if (!record) return null;
    const radius = this.currentRadius(userId);
    const candidates = this.store.zrangebyscore(
      bracketEloKey(record.bracket),
      record.elo - radius,
      record.elo + radius
    );

    let best: QueuedUser | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      if (c.member === userId) continue;
      const candidateRecord = this.metadata.get(c.member);
      if (!candidateRecord) continue;
      const distance = Math.abs(candidateRecord.elo - record.elo);
      if (distance < bestDistance) {
        best = candidateRecord;
        bestDistance = distance;
      }
    }
    return best ? { ...best } : null;
  }

  /**
   * Atomically dequeue a match for `userId`, returning both participants. Uses
   * `findMatch` to pick the closest peer, then removes both from the queue and
   * emits a `match` event.
   */
  popMatch(userId: string): { a: QueuedUser; b: QueuedUser } | null {
    const a = this.getRecord(userId);
    if (!a) return null;
    const b = this.findMatch(userId);
    if (!b) return null;
    this.remove(a.userId);
    this.remove(b.userId);
    this.emitter.emit('match', { a, b, bracket: a.bracket });
    return { a, b };
  }

  /** Flush every bracket – used for tests. */
  flush(): void {
    this.store.flushall();
    this.metadata.clear();
  }
}
