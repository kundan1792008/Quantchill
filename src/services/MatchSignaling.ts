/**
 * MatchSignaling – WebRTC room orchestration for matched pairs.
 *
 * When `MatchQueue.popMatch` emits a match, `MatchSignaling.createRoom` allocates
 * a new room UUID and returns the credentials that both users need to connect
 * via WebRTC. If either peer fails to connect within `connectTimeoutMs`
 * (default 10 000 ms), the room is torn down and the callback provided to
 * `onTimeout` is fired so the caller can re-queue both users.
 *
 * The class intentionally holds no network sockets itself – broadcast is the
 * caller's responsibility via `broadcast` in the options, which is called with
 * the user id and the payload to deliver. That keeps the service transport
 * agnostic and testable without a WebSocket server.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** A single peer inside a signaling room. */
export interface SignalingPeer {
  userId: string;
  connected: boolean;
  joinedAt?: number;
}

/** Room lifecycle states. */
export type RoomStatus = 'pending' | 'active' | 'timeout' | 'closed';

/** A signaling room. */
export interface SignalingRoom {
  roomId: string;
  createdAt: number;
  peers: [SignalingPeer, SignalingPeer];
  status: RoomStatus;
  /** TURN/STUN credentials returned to both peers. */
  iceServers: RTCIceServerConfig[];
}

/** Public RTCIceServer representation. */
export interface RTCIceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Broadcast function – the caller ships a payload to a user via their transport. */
export type BroadcastFn = (userId: string, payload: unknown) => void;

/** Callback fired when a room times out. */
export type TimeoutFn = (room: SignalingRoom) => void;

/** Configuration for `MatchSignaling`. */
export interface MatchSignalingOptions {
  /** Transport broadcaster – required for real usage, optional in tests. */
  broadcast?: BroadcastFn;
  /** Called when a room times out so both users can be re-queued. */
  onTimeout?: TimeoutFn;
  /** Connect deadline in milliseconds. Default 10 000. */
  connectTimeoutMs?: number;
  /** Default ICE servers sent to both peers. */
  iceServers?: RTCIceServerConfig[];
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** Scheduler override so tests can drive the clock without real timers. */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => NodeJS.Timeout;
    clearTimeout: (handle: NodeJS.Timeout) => void;
  };
}

/** Events emitted by `MatchSignaling`. */
export interface MatchSignalingEvents {
  'room-created': SignalingRoom;
  'room-active': SignalingRoom;
  'room-timeout': SignalingRoom;
  'room-closed': SignalingRoom;
  'signal-relay': { roomId: string; fromUserId: string; toUserId: string; payload: unknown };
}

const DEFAULT_ICE_SERVERS: RTCIceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' }
];

/** Orchestrate WebRTC signaling rooms between matched users. */
export class MatchSignaling {
  private readonly broadcast?: BroadcastFn;
  private readonly onTimeout?: TimeoutFn;
  private readonly connectTimeoutMs: number;
  private readonly iceServers: RTCIceServerConfig[];
  private readonly now: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (h: NodeJS.Timeout) => void;

  private readonly rooms = new Map<string, SignalingRoom>();
  private readonly userToRoom = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly emitter = new EventEmitter();

  constructor(options: MatchSignalingOptions = {}) {
    this.broadcast = options.broadcast;
    this.onTimeout = options.onTimeout;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.scheduler?.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.scheduler?.clearTimeout ?? clearTimeout;
  }

  /** Subscribe to signaling events. */
  on<K extends keyof MatchSignalingEvents>(
    event: K,
    listener: (payload: MatchSignalingEvents[K]) => void
  ): void {
    this.emitter.on(event, listener);
  }

  /** Unsubscribe from signaling events. */
  off<K extends keyof MatchSignalingEvents>(
    event: K,
    listener: (payload: MatchSignalingEvents[K]) => void
  ): void {
    this.emitter.off(event, listener);
  }

  /** Return the active room for a user, if any. */
  getRoomForUser(userId: string): SignalingRoom | null {
    const roomId = this.userToRoom.get(userId);
    return roomId ? this.rooms.get(roomId) ?? null : null;
  }

  /** Return a room by id. */
  getRoom(roomId: string): SignalingRoom | null {
    return this.rooms.get(roomId) ?? null;
  }

  /**
   * Create a new room for the given users and notify both via `broadcast`.
   *
   * Emits `room-created` synchronously. Schedules a timeout that fires
   * `room-timeout` and calls `onTimeout` if both peers have not called
   * `markConnected` within `connectTimeoutMs`.
   */
  createRoom(userIdA: string, userIdB: string): SignalingRoom {
    const roomId = randomUUID();
    const createdAt = this.now();
    const room: SignalingRoom = {
      roomId,
      createdAt,
      peers: [
        { userId: userIdA, connected: false },
        { userId: userIdB, connected: false }
      ],
      status: 'pending',
      iceServers: this.iceServers
    };
    this.rooms.set(roomId, room);
    this.userToRoom.set(userIdA, roomId);
    this.userToRoom.set(userIdB, roomId);

    const payload = {
      type: 'match-found',
      roomId,
      iceServers: this.iceServers,
      peers: [userIdA, userIdB],
      connectDeadlineMs: this.connectTimeoutMs,
      createdAt
    };
    this.broadcast?.(userIdA, { ...payload, peerUserId: userIdB, initiator: true });
    this.broadcast?.(userIdB, { ...payload, peerUserId: userIdA, initiator: false });

    this.emitter.emit('room-created', room);

    const timer = this.setTimeoutFn(() => this.handleTimeout(roomId), this.connectTimeoutMs);
    this.timers.set(roomId, timer);

    return room;
  }

  /** Mark a peer as connected; when both are connected the room turns `active`. */
  markConnected(roomId: string, userId: string): SignalingRoom | null {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'pending') return null;
    const peer = room.peers.find((p) => p.userId === userId);
    if (!peer) return null;
    peer.connected = true;
    peer.joinedAt = this.now();
    if (room.peers.every((p) => p.connected)) {
      room.status = 'active';
      this.clearTimer(roomId);
      this.emitter.emit('room-active', room);
    }
    return room;
  }

  /**
   * Relay a WebRTC signaling payload (offer / answer / ice-candidate) between
   * peers in a room. Returns `true` on success.
   */
  relay(roomId: string, fromUserId: string, payload: unknown): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const toPeer = room.peers.find((p) => p.userId !== fromUserId);
    if (!toPeer) return false;
    this.broadcast?.(toPeer.userId, {
      type: 'signal-relay',
      roomId,
      fromUserId,
      payload,
      relayedAt: this.now()
    });
    this.emitter.emit('signal-relay', {
      roomId,
      fromUserId,
      toUserId: toPeer.userId,
      payload
    });
    return true;
  }

  /** Close a room and notify both peers. */
  closeRoom(roomId: string, reason: string = 'closed'): SignalingRoom | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.status = 'closed';
    this.clearTimer(roomId);
    for (const peer of room.peers) {
      this.userToRoom.delete(peer.userId);
      this.broadcast?.(peer.userId, { type: 'room-closed', roomId, reason });
    }
    this.rooms.delete(roomId);
    this.emitter.emit('room-closed', room);
    return room;
  }

  /** Number of live rooms – used for metrics / tests. */
  roomCount(): number {
    return this.rooms.size;
  }

  private clearTimer(roomId: string): void {
    const timer = this.timers.get(roomId);
    if (timer) {
      this.clearTimeoutFn(timer);
      this.timers.delete(roomId);
    }
  }

  private handleTimeout(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'pending') return;
    room.status = 'timeout';
    for (const peer of room.peers) {
      this.userToRoom.delete(peer.userId);
      this.broadcast?.(peer.userId, {
        type: 'match-timeout',
        roomId,
        reason: 'peer-did-not-connect'
      });
    }
    this.rooms.delete(roomId);
    this.timers.delete(roomId);
    this.emitter.emit('room-timeout', room);
    this.onTimeout?.(room);
  }
}
