/**
 * MatchSignaling — orchestrates the hand-off between "users are queued" and
 * "users are connected via WebRTC".
 *
 * Flow:
 *   1. `createRoom(a, b)` once MatchQueue has produced a pair.
 *   2. Emit `match-found` to both sides, carrying the roomId and SDP role
 *      assignment (`polite` / `impolite`, Glickman's "perfect-negotiation" idiom).
 *   3. Relay SDP offer / answer / ICE candidates through the signaling channel.
 *   4. If either side does not reach `connected` within `connectTimeoutMs`
 *      (default 10 s), invoke the re-queue callback for both.
 *
 * This module is transport-agnostic: callers pass a `sendFn` that transmits
 * the message to the right peer (WebSocket, SSE, Fastify push, etc.). That
 * keeps the service trivial to test — `MatchSignaling.test.ts` uses in-memory
 * capture.
 */

import { randomUUID } from 'node:crypto';

/** Role assignment used by WebRTC perfect-negotiation. */
export type SignalingRole = 'polite' | 'impolite';

/** Lifecycle state of a signaling room. */
export type RoomStatus =
  | 'pending'       // created, waiting for offer
  | 'offering'      // caller has sent SDP offer
  | 'answering'     // callee has sent SDP answer
  | 'connected'     // both sides report `connected` via `markConnected`
  | 'expired'       // connect timeout fired
  | 'closed';       // gracefully ended

/** Participant metadata held inside a room. */
export interface RoomParticipant {
  userId: string;
  role: SignalingRole;
  joinedAt: number;
  connectedAt: number | null;
}

/** Signaling room state. */
export interface SignalingRoom {
  roomId: string;
  participants: [RoomParticipant, RoomParticipant];
  status: RoomStatus;
  createdAt: number;
  expiresAt: number;
  closedReason: string | null;
}

/** Messages the signaling layer pushes to peers. */
export type SignalingOutbound =
  | {
      type: 'match-found';
      roomId: string;
      peerUserId: string;
      role: SignalingRole;
      iceServers: RTCIceServerLike[];
      expiresAt: number;
    }
  | { type: 'offer'; roomId: string; fromUserId: string; sdp: unknown }
  | { type: 'answer'; roomId: string; fromUserId: string; sdp: unknown }
  | { type: 'ice-candidate'; roomId: string; fromUserId: string; candidate: unknown }
  | { type: 'room-expired'; roomId: string; reason: 'connect-timeout'; expiredAt: number }
  | { type: 'room-closed'; roomId: string; reason: string; closedAt: number };

/** Minimal ICE server description — shape matches `RTCIceServer`. */
export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Callback signature for transport delivery. */
export type SignalingSendFn = (userId: string, message: SignalingOutbound) => void;

/** Callback invoked when a room times out — used to re-queue both users. */
export type RoomTimeoutFn = (room: SignalingRoom) => void;

/** Config knobs for the signaling service. */
export interface MatchSignalingConfig {
  connectTimeoutMs: number;
  iceServers: RTCIceServerLike[];
}

export const DEFAULT_SIGNALING_CONFIG: MatchSignalingConfig = {
  connectTimeoutMs: 10_000,
  iceServers: [{ urls: 'stun:stun.quantchill.io:3478' }]
};

/**
 * A room is scheduled via `setTimeout`; we retain the handle so we can cancel
 * cleanly on explicit `markConnected` or `close`. In tests we inject a fake
 * scheduler via constructor arguments.
 */
export interface TimerLike {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  now(): number;
}

export type TimerHandle = unknown;

export const NODE_TIMER: TimerLike = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now()
};

/** The signaling service. */
export class MatchSignaling {
  private readonly rooms = new Map<string, SignalingRoom>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly byUser = new Map<string, Set<string>>();
  private readonly config: MatchSignalingConfig;

  constructor(
    private readonly send: SignalingSendFn,
    private readonly onTimeout: RoomTimeoutFn,
    overrides: Partial<MatchSignalingConfig> = {},
    private readonly timer: TimerLike = NODE_TIMER
  ) {
    this.config = { ...DEFAULT_SIGNALING_CONFIG, ...overrides };
  }

  /** Create a room for a newly-matched pair and emit `match-found` to both. */
  createRoom(userAId: string, userBId: string): SignalingRoom {
    if (userAId === userBId) {
      throw new Error('createRoom: users must be distinct');
    }

    const roomId = randomUUID();
    const now = this.timer.now();
    const expiresAt = now + this.config.connectTimeoutMs;

    // Deterministic role assignment based on lexical order of userIds —
    // satisfies perfect-negotiation symmetry without an extra round-trip.
    const [politeId, impoliteId] = [userAId, userBId].sort() as [string, string];

    const participants: [RoomParticipant, RoomParticipant] = [
      { userId: politeId, role: 'polite', joinedAt: now, connectedAt: null },
      { userId: impoliteId, role: 'impolite', joinedAt: now, connectedAt: null }
    ];

    const room: SignalingRoom = {
      roomId,
      participants,
      status: 'pending',
      createdAt: now,
      expiresAt,
      closedReason: null
    };

    this.rooms.set(roomId, room);
    this.indexUser(userAId, roomId);
    this.indexUser(userBId, roomId);

    for (const participant of participants) {
      const peer = participants.find((p) => p.userId !== participant.userId)!;
      this.send(participant.userId, {
        type: 'match-found',
        roomId,
        peerUserId: peer.userId,
        role: participant.role,
        iceServers: this.config.iceServers,
        expiresAt
      });
    }

    const handle = this.timer.setTimeout(() => this.expireRoom(roomId), this.config.connectTimeoutMs);
    this.timers.set(roomId, handle);

    return { ...room, participants: [...participants] as [RoomParticipant, RoomParticipant] };
  }

  /** Relay an SDP offer from one participant to the other. */
  relayOffer(roomId: string, fromUserId: string, sdp: unknown): void {
    const { room, peer } = this.requireOtherParticipant(roomId, fromUserId);
    room.status = 'offering';
    this.send(peer.userId, { type: 'offer', roomId, fromUserId, sdp });
  }

  /** Relay an SDP answer back to the caller. */
  relayAnswer(roomId: string, fromUserId: string, sdp: unknown): void {
    const { room, peer } = this.requireOtherParticipant(roomId, fromUserId);
    room.status = 'answering';
    this.send(peer.userId, { type: 'answer', roomId, fromUserId, sdp });
  }

  /** Relay an ICE candidate to the peer. */
  relayIceCandidate(roomId: string, fromUserId: string, candidate: unknown): void {
    const { peer } = this.requireOtherParticipant(roomId, fromUserId);
    this.send(peer.userId, { type: 'ice-candidate', roomId, fromUserId, candidate });
  }

  /**
   * Mark a participant as having reached the `connected` ICE state.
   * When both participants have reported connected, the room is promoted
   * to `connected` and the timeout is cancelled.
   */
  markConnected(roomId: string, userId: string): SignalingRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`markConnected: unknown room ${roomId}`);
    const participant = room.participants.find((p) => p.userId === userId);
    if (!participant) throw new Error(`markConnected: ${userId} not in room ${roomId}`);

    participant.connectedAt = this.timer.now();
    if (room.participants.every((p) => p.connectedAt !== null)) {
      room.status = 'connected';
      this.cancelTimer(roomId);
    }

    return { ...room, participants: [...room.participants] as [RoomParticipant, RoomParticipant] };
  }

  /**
   * Close a room gracefully. Used when one peer sends "end-call" or
   * disconnects from the websocket, or when the caller wants to force
   * re-queue without waiting for the connect timer.
   */
  closeRoom(roomId: string, reason: string): SignalingRoom | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    this.cancelTimer(roomId);
    room.status = 'closed';
    room.closedReason = reason;

    const closedAt = this.timer.now();
    for (const participant of room.participants) {
      this.send(participant.userId, { type: 'room-closed', roomId, reason, closedAt });
      this.deindexUser(participant.userId, roomId);
    }
    this.rooms.delete(roomId);
    return room;
  }

  /** Look up the room a given user is currently in, if any. */
  roomsForUser(userId: string): string[] {
    return Array.from(this.byUser.get(userId) ?? []);
  }

  /** Number of live rooms — useful for metrics dashboards. */
  activeRoomCount(): number {
    return this.rooms.size;
  }

  /** Snapshot a room by id (or `null` if unknown). */
  getRoom(roomId: string): SignalingRoom | null {
    const room = this.rooms.get(roomId);
    return room ? { ...room, participants: [...room.participants] as [RoomParticipant, RoomParticipant] } : null;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private requireOtherParticipant(
    roomId: string,
    fromUserId: string
  ): { room: SignalingRoom; peer: RoomParticipant } {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`signaling: unknown room ${roomId}`);
    const peer = room.participants.find((p) => p.userId !== fromUserId);
    if (!peer) throw new Error(`signaling: ${fromUserId} not in room ${roomId}`);
    return { room, peer };
  }

  private expireRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.status === 'connected' || room.status === 'closed') return;

    room.status = 'expired';
    room.closedReason = 'connect-timeout';

    const expiredAt = this.timer.now();
    for (const participant of room.participants) {
      this.send(participant.userId, { type: 'room-expired', roomId, reason: 'connect-timeout', expiredAt });
      this.deindexUser(participant.userId, roomId);
    }

    try {
      this.onTimeout(room);
    } finally {
      this.rooms.delete(roomId);
      this.timers.delete(roomId);
    }
  }

  private cancelTimer(roomId: string): void {
    const handle = this.timers.get(roomId);
    if (handle !== undefined) {
      this.timer.clearTimeout(handle);
      this.timers.delete(roomId);
    }
  }

  private indexUser(userId: string, roomId: string): void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(roomId);
  }

  private deindexUser(userId: string, roomId: string): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    set.delete(roomId);
    if (set.size === 0) this.byUser.delete(userId);
  }
}
