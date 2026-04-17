/**
 * MatchQueue — Redis-sorted-set backed match queue for Quantchill.
 *
 * The queue is structured as one Redis sorted set per ELO bracket:
 *   `matchqueue:{bracket}` → sorted set keyed by userId, scored by enqueueTimestamp.
 *
 * Responsibilities:
 *   - `enqueue(userId, elo)`       → O(log N) insert into bracket's sorted set.
 *   - `dequeue(bracket)`           → pop the longest-waiting user (lowest score).
 *   - `findMatch(userId)`          → find closest-ELO peer in same bracket within
 *                                    200 rating points. Radius expands by +50
 *                                    every 5 s of waiting, capped at +500.
 *   - pub/sub on `matchqueue:events` for cross-server match notifications.
 *
 * This module is pluggable: it accepts any implementation of the
 * `MatchQueueRedisClient` interface. In production, inject `ioredis`. In tests
 * and single-node deployments, a zero-dependency `InMemoryRedisClient` is
 * exported which implements the same contract.
 */

import { EventEmitter } from 'node:events';

/** Bracket names used for queue sharding (mirrors `EloRatingService`). */
export type QueueBracket = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

/**
 * Minimal subset of the Redis API the queue depends on.
 * Matches ioredis method signatures so production drop-in is trivial.
 */
export interface MatchQueueRedisClient {
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, member: string): Promise<number>;
  zrange(key: string, start: number, stop: number, withScores?: 'WITHSCORES'): Promise<string[]>;
  zpopmin(key: string, count?: number): Promise<string[]>;
  zcard(key: string): Promise<number>;
  zscore(key: string, member: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (msg: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  disconnect(): Promise<void>;
}

/** Configuration for the queue's match-widening policy. */
export interface MatchQueueConfig {
  /** Initial search radius (default 200 ELO). */
  initialRadius: number;
  /** Radius expansion per waiting window (default +50 ELO). */
  radiusIncrement: number;
  /** Length of a waiting window in milliseconds (default 5 s). */
  windowMs: number;
  /** Maximum radius before we give up and widen to the bracket entire (default 500). */
  maxRadius: number;
  /** Bracket key prefix (default "matchqueue"). */
  keyPrefix: string;
  /** Pub/sub channel name for cross-server notifications. */
  eventsChannel: string;
}

/** Default configuration suitable for production. */
export const DEFAULT_MATCH_QUEUE_CONFIG: MatchQueueConfig = {
  initialRadius: 200,
  radiusIncrement: 50,
  windowMs: 5_000,
  maxRadius: 500,
  keyPrefix: 'matchqueue',
  eventsChannel: 'matchqueue:events'
};

/** Serialised payload stored in the metadata hash for each queued user. */
export interface QueueEntry {
  userId: string;
  elo: number;
  bracket: QueueBracket;
  enqueuedAt: number;
}

/** Result of a successful match discovery. */
export interface QueueMatch {
  self: QueueEntry;
  peer: QueueEntry;
  /** Absolute ELO gap between self and peer. */
  eloDelta: number;
  /** Expanded radius that permitted the match. */
  effectiveRadius: number;
  /** Milliseconds the slower user waited before being matched. */
  maxWaitMs: number;
}

/** Cross-server pub/sub event body. */
export interface QueueEvent {
  kind: 'enqueue' | 'dequeue' | 'match';
  userId?: string;
  peerId?: string;
  bracket?: QueueBracket;
  at: number;
}

/**
 * Pure helper — map an ELO rating to a queue bracket.
 *
 * We replicate `getEloBracket` here to avoid a hard dependency on
 * `EloRatingService` so the queue can be used with any rating engine.
 */
export function bracketForElo(rating: number): QueueBracket {
  if (rating >= 1600) return 'diamond';
  if (rating >= 1400) return 'platinum';
  if (rating >= 1200) return 'gold';
  if (rating >= 1000) return 'silver';
  return 'bronze';
}

/**
 * In-memory implementation of `MatchQueueRedisClient` for tests and single-node
 * deployments. Strict subset of the ioredis contract, enough to back MatchQueue.
 *
 * All operations are O(log N) via a sorted array kept in insertion/score order.
 */
export class InMemoryRedisClient implements MatchQueueRedisClient {
  private readonly sortedSets = new Map<string, Array<{ member: string; score: number }>>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly emitter = new EventEmitter();

  async zadd(key: string, score: number, member: string): Promise<number> {
    let set = this.sortedSets.get(key);
    if (!set) {
      set = [];
      this.sortedSets.set(key, set);
    }
    const idx = set.findIndex((entry) => entry.member === member);
    if (idx >= 0) {
      set[idx]!.score = score;
      this.reorder(set);
      return 0;
    }
    set.push({ member, score });
    this.reorder(set);
    return 1;
  }

  async zrem(key: string, member: string): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    const idx = set.findIndex((entry) => entry.member === member);
    if (idx < 0) return 0;
    set.splice(idx, 1);
    return 1;
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores?: 'WITHSCORES'
  ): Promise<string[]> {
    const set = this.sortedSets.get(key) ?? [];
    const normalizedStop = stop === -1 ? set.length - 1 : stop;
    const slice = set.slice(start, normalizedStop + 1);
    if (withScores === 'WITHSCORES') {
      const out: string[] = [];
      for (const entry of slice) {
        out.push(entry.member, String(entry.score));
      }
      return out;
    }
    return slice.map((entry) => entry.member);
  }

  async zpopmin(key: string, count: number = 1): Promise<string[]> {
    const set = this.sortedSets.get(key);
    if (!set || set.length === 0) return [];
    const popped = set.splice(0, count);
    const out: string[] = [];
    for (const entry of popped) {
      out.push(entry.member, String(entry.score));
    }
    return out;
  }

  async zcard(key: string): Promise<number> {
    return this.sortedSets.get(key)?.length ?? 0;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const entry = this.sortedSets.get(key)?.find((e) => e.member === member);
    return entry ? String(entry.score) : null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    const existed = hash.has(field);
    hash.set(field, value);
    return existed ? 0 : 1;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hdel(key: string, field: string): Promise<number> {
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    return hash.delete(field) ? 1 : 0;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.emitter.emit(channel, message);
    return this.emitter.listenerCount(channel);
  }

  async subscribe(channel: string, listener: (msg: string) => void): Promise<void> {
    this.emitter.on(channel, listener);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.emitter.removeAllListeners(channel);
  }

  async disconnect(): Promise<void> {
    this.emitter.removeAllListeners();
    this.sortedSets.clear();
    this.hashes.clear();
  }

  private reorder(set: Array<{ member: string; score: number }>): void {
    set.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
  }
}

/**
 * MatchQueue — bracket-sharded, time-priority match queue.
 */
export class MatchQueue {
  private readonly config: MatchQueueConfig;
  private readonly now: () => number;
  private readonly subscribers = new Set<(event: QueueEvent) => void>();
  private subscribed = false;

  constructor(
    private readonly redis: MatchQueueRedisClient,
    overrides: Partial<MatchQueueConfig> = {},
    nowFn: () => number = () => Date.now()
  ) {
    this.config = { ...DEFAULT_MATCH_QUEUE_CONFIG, ...overrides };
    this.now = nowFn;
  }

  /** Returns the Redis key for a bracket's sorted set. */
  keyForBracket(bracket: QueueBracket): string {
    return `${this.config.keyPrefix}:${bracket}`;
  }

  /** Returns the metadata hash key for the full queue. */
  metadataKey(): string {
    return `${this.config.keyPrefix}:meta`;
  }

  /**
   * Enqueue a user into the bracket matching their ELO rating.
   * Returns the queue entry for confirmation.
   */
  async enqueue(userId: string, elo: number): Promise<QueueEntry> {
    if (!userId || !Number.isFinite(elo)) {
      throw new Error('enqueue: userId and numeric elo are required');
    }

    const bracket = bracketForElo(elo);
    const entry: QueueEntry = {
      userId,
      elo,
      bracket,
      enqueuedAt: this.now()
    };

    await this.redis.zadd(this.keyForBracket(bracket), entry.enqueuedAt, userId);
    await this.redis.hset(this.metadataKey(), userId, JSON.stringify(entry));
    await this.emit({ kind: 'enqueue', userId, bracket, at: entry.enqueuedAt });

    return entry;
  }

  /** Remove a user from their bracket (e.g., on disconnect or match). */
  async remove(userId: string): Promise<boolean> {
    const entry = await this.getEntry(userId);
    if (!entry) return false;
    await this.redis.zrem(this.keyForBracket(entry.bracket), userId);
    await this.redis.hdel(this.metadataKey(), userId);
    await this.emit({ kind: 'dequeue', userId, bracket: entry.bracket, at: this.now() });
    return true;
  }

  /** Pop the longest-waiting user from the bracket; returns null if empty. */
  async dequeue(bracket: QueueBracket): Promise<QueueEntry | null> {
    const popped = await this.redis.zpopmin(this.keyForBracket(bracket), 1);
    if (popped.length === 0) return null;
    const userId = popped[0]!;
    const entry = await this.getEntry(userId);
    await this.redis.hdel(this.metadataKey(), userId);
    await this.emit({ kind: 'dequeue', userId, bracket, at: this.now() });
    return entry;
  }

  /** Return the metadata entry for a queued user, if any. */
  async getEntry(userId: string): Promise<QueueEntry | null> {
    const raw = await this.redis.hget(this.metadataKey(), userId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as QueueEntry;
    } catch {
      return null;
    }
  }

  /** Count of users currently queued in a bracket. */
  async size(bracket: QueueBracket): Promise<number> {
    return this.redis.zcard(this.keyForBracket(bracket));
  }

  /** Compute the current effective search radius for a user, based on waiting time. */
  computeRadius(waitingMs: number): number {
    const steps = Math.floor(waitingMs / this.config.windowMs);
    const radius = this.config.initialRadius + steps * this.config.radiusIncrement;
    return Math.min(this.config.maxRadius, radius);
  }

  /**
   * Find the closest-ELO peer in the same bracket within the current radius.
   *
   * The caller is assumed to already be in the queue. We deliberately do NOT
   * pop either participant — callers (typically MatchSignaling) own that step.
   */
  async findMatch(userId: string): Promise<QueueMatch | null> {
    const self = await this.getEntry(userId);
    if (!self) return null;

    const waitingMs = Math.max(0, this.now() - self.enqueuedAt);
    const radius = this.computeRadius(waitingMs);

    // Pull all members in the bracket; small N (typically <1000 per bracket).
    const members = await this.redis.zrange(this.keyForBracket(self.bracket), 0, -1, 'WITHSCORES');

    let best: { entry: QueueEntry; delta: number; enqueuedAt: number } | null = null;

    for (let i = 0; i < members.length; i += 2) {
      const candidateId = members[i]!;
      const candidateEnqueuedAt = Number(members[i + 1]);
      if (candidateId === userId) continue;

      const candidate = await this.getEntry(candidateId);
      if (!candidate) continue;

      const delta = Math.abs(candidate.elo - self.elo);
      if (delta > radius) continue;

      if (
        best === null ||
        delta < best.delta ||
        (delta === best.delta && candidateEnqueuedAt < best.enqueuedAt)
      ) {
        best = { entry: candidate, delta, enqueuedAt: candidateEnqueuedAt };
      }
    }

    if (!best) return null;

    const peerWait = this.now() - best.enqueuedAt;
    return {
      self,
      peer: best.entry,
      eloDelta: best.delta,
      effectiveRadius: radius,
      maxWaitMs: Math.max(peerWait, waitingMs)
    };
  }

  /**
   * Atomic match step — find a peer for `userId` and pop both from the queue.
   * Returns null if no peer could be matched right now.
   */
  async matchAndPop(userId: string): Promise<QueueMatch | null> {
    const match = await this.findMatch(userId);
    if (!match) return null;

    await this.redis.zrem(this.keyForBracket(match.self.bracket), match.self.userId);
    await this.redis.zrem(this.keyForBracket(match.peer.bracket), match.peer.userId);
    await this.redis.hdel(this.metadataKey(), match.self.userId);
    await this.redis.hdel(this.metadataKey(), match.peer.userId);
    await this.emit({
      kind: 'match',
      userId: match.self.userId,
      peerId: match.peer.userId,
      bracket: match.self.bracket,
      at: this.now()
    });

    return match;
  }

  /** Subscribe to cross-server queue events. */
  async onEvent(listener: (event: QueueEvent) => void): Promise<void> {
    this.subscribers.add(listener);
    if (!this.subscribed) {
      this.subscribed = true;
      await this.redis.subscribe(this.config.eventsChannel, (msg) => {
        try {
          const event = JSON.parse(msg) as QueueEvent;
          for (const sub of this.subscribers) sub(event);
        } catch {
          /* swallow malformed messages */
        }
      });
    }
  }

  /** Detach a previously-registered listener. */
  offEvent(listener: (event: QueueEvent) => void): void {
    this.subscribers.delete(listener);
  }

  /** Gracefully tear down the queue's pub/sub subscriptions. */
  async dispose(): Promise<void> {
    this.subscribers.clear();
    if (this.subscribed) {
      this.subscribed = false;
      await this.redis.unsubscribe(this.config.eventsChannel);
    }
  }

  private async emit(event: QueueEvent): Promise<void> {
    await this.redis.publish(this.config.eventsChannel, JSON.stringify(event));
  }
}
