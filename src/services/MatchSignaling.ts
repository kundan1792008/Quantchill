/**
 * MatchSignaling – WebRTC signaling service for matched pairs.
 *
 * Responsibilities:
 *  1. Create a unique room ID when a match is found via MatchQueue.
 *  2. Notify both matched users with a `match-found` event that contains
 *     their room credentials.
 *  3. Relay WebRTC offer / answer / ICE-candidate messages between the two
 *     peers through the signaling channel.
 *  4. Enforce a 10-second connection deadline: if either user has not sent
 *     an offer or answer within the window, both are re-queued via the
 *     provided callback.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { MatchPair, QueueEntry } from './MatchQueue';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Milliseconds both peers have to exchange WebRTC signaling before re-queue. */
const CONNECT_TIMEOUT_MS = 10_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Credentials sent to both participants when a match is found. */
export interface RoomCredentials {
  roomId: string;
  token: string;
  expiresAt: number;
}

/** Internal state tracked per active signaling room. */
interface RoomState {
  roomId: string;
  userA: QueueEntry;
  userB: QueueEntry;
  offerReceived: boolean;
  answerReceived: boolean;
  timeoutHandle: ReturnType<typeof setTimeout>;
  createdAt: number;
}

/** A WebRTC signaling message forwarded between peers. */
export interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  fromUserId: string;
  toUserId: string;
  payload: unknown;
  roomId: string;
}

/** Callback invoked to re-queue a user when a connection timeout fires. */
export type RequeueCallback = (userId: string, elo: number) => void;

// ─── MatchSignaling ───────────────────────────────────────────────────────────

/**
 * MatchSignaling manages the lifecycle of a WebRTC signaling room from the
 * moment a match is found until the connection is established (or times out).
 *
 * Events emitted:
 *  - `room-created`   (roomId: string, userA: QueueEntry, userB: QueueEntry)
 *  - `signal`         (msg: SignalingMessage) – forwarded signaling message
 *  - `room-connected` (roomId: string) – both peers have exchanged offer+answer
 *  - `room-timeout`   (roomId: string) – connection not established in time
 *  - `room-closed`    (roomId: string) – room torn down after peer disconnect
 */
export class MatchSignaling extends EventEmitter {
  /** Active signaling rooms keyed by roomId. */
  private readonly rooms = new Map<string, RoomState>();

  /** roomId → token map for lightweight credential verification. */
  private readonly tokens = new Map<string, string>();

  constructor(private readonly onRequeue?: RequeueCallback) {
    super();
  }

  // ── Room lifecycle ───────────────────────────────────────────────────────

  /**
   * Create a new signaling room for a matched pair and schedule the
   * connection timeout.
   *
   * Returns the RoomCredentials that should be forwarded to both users via
   * whatever transport layer owns the WebSocket connections (e.g. server.ts).
   */
  createRoom(pair: MatchPair): { credentials: RoomCredentials; userAId: string; userBId: string } {
    const roomId = randomUUID();
    const token = randomUUID();
    const expiresAt = Date.now() + CONNECT_TIMEOUT_MS;

    const timeoutHandle = setTimeout(() => {
      this.handleTimeout(roomId);
    }, CONNECT_TIMEOUT_MS);

    const state: RoomState = {
      roomId,
      userA: pair.userA,
      userB: pair.userB,
      offerReceived: false,
      answerReceived: false,
      timeoutHandle,
      createdAt: Date.now()
    };

    this.rooms.set(roomId, state);
    this.tokens.set(roomId, token);

    this.emit('room-created', roomId, pair.userA, pair.userB);

    const credentials: RoomCredentials = { roomId, token, expiresAt };
    return { credentials, userAId: pair.userA.userId, userBId: pair.userB.userId };
  }

  /**
   * Handle an incoming WebRTC signaling message.
   *
   * Validates that:
   *  - The room exists.
   *  - The sender is a participant in the room.
   *  - The recipient is the other participant.
   *
   * Emits a `signal` event containing the message so the transport layer can
   * forward it to the target user's WebSocket connection.
   *
   * Tracks offer/answer receipt to detect when the connection is established.
   *
   * @returns true if the message was accepted, false otherwise.
   */
  relay(msg: SignalingMessage): boolean {
    const room = this.rooms.get(msg.roomId);
    if (!room) return false;

    const participants = [room.userA.userId, room.userB.userId];
    if (!participants.includes(msg.fromUserId)) return false;
    if (!participants.includes(msg.toUserId)) return false;
    if (msg.fromUserId === msg.toUserId) return false;

    if (msg.type === 'offer') room.offerReceived = true;
    if (msg.type === 'answer') room.answerReceived = true;

    this.emit('signal', msg);

    // Both sides have exchanged – connection is established.
    if (room.offerReceived && room.answerReceived) {
      this.markConnected(msg.roomId);
    }

    return true;
  }

  /**
   * Close an active room (e.g. on peer disconnect or call end).
   * Clears the timeout and removes the room from state.
   */
  closeRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    clearTimeout(room.timeoutHandle);
    this.rooms.delete(roomId);
    this.tokens.delete(roomId);

    this.emit('room-closed', roomId);
    return true;
  }

  /** Verify that a token is valid for a given room. */
  verifyToken(roomId: string, token: string): boolean {
    return this.tokens.get(roomId) === token;
  }

  /** Return whether a room currently exists. */
  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  /** Return a snapshot of current room state (for monitoring). */
  getRoomState(roomId: string): Readonly<RoomState> | null {
    return this.rooms.get(roomId) ?? null;
  }

  /** Return the count of active rooms. */
  activeRoomCount(): number {
    return this.rooms.size;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private markConnected(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    clearTimeout(room.timeoutHandle);
    this.emit('room-connected', roomId);
  }

  private handleTimeout(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    this.rooms.delete(roomId);
    this.tokens.delete(roomId);

    this.emit('room-timeout', roomId);

    // Re-queue both users if a callback was provided.
    if (this.onRequeue) {
      this.onRequeue(room.userA.userId, room.userA.elo);
      this.onRequeue(room.userB.userId, room.userB.elo);
    }
  }
}
