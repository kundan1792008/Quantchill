import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { RawData, WebSocket } from 'ws';
import { BiometricHandshakeService, BiometricPayload } from './services/BiometricHandshakeService';
import { MatchMaker, UserProfile, BCIContext } from './services/MatchMaker';
import { MoodEngine, MoodName } from './services/MoodEngine';
import { SessionTracker } from './services/SessionTracker';
import { EloRatingService, SwipeOutcome } from './services/EloRatingService';
import { HiveMindAlgorithm } from './services/HiveMindAlgorithm';
import { RateLimiter } from './services/RateLimiter';
import { SafetyService, ReportReason } from './services/SafetyService';

type SocketMessage =
  | { type: 'register'; userId: string; interestGraph: Record<string, number>; bciContext?: BCIContext }
  | { type: 'offer' | 'answer' | 'ice-candidate'; targetUserId: string; payload: unknown }
  | { type: 'swap-video'; targetUserId: string; requestId?: string; startedAt?: number }
  | { type: 'biometric-handshake'; payload: BiometricPayload }
  | { type: 'biometric-update'; payload: BiometricPayload }
  | { type: 'match-request'; bciContext: BCIContext }
  | { type: 'swipe'; subjectUserId: string; outcome: SwipeOutcome; featureKey?: string }
  | { type: 'block'; subjectUserId: string }
  | { type: 'unblock'; subjectUserId: string }
  | { type: 'report'; subjectUserId: string; reason: ReportReason; note?: string }
  | { type: 'ping'; sentAt?: number };

interface ClientState {
  socket: WebSocket;
  profile?: UserProfile;
  connectedAt: number;
  authenticated: boolean;
}

const app = Fastify({ logger: true });
const handshakeService = new BiometricHandshakeService();
const hiveMind = new HiveMindAlgorithm();
const matchMaker = new MatchMaker(40, hiveMind);
const eloService = new EloRatingService();
const sessionTracker = new SessionTracker();
const safetyService = new SafetyService();

/**
 * Per-connection rate limits.
 *
 * Tuned for a video-dating WS where humans drive most events:
 * - `match-request` bursts during first load but settles to ~1/s.
 * - `swipe` must tolerate rapid-fire input (≈5/s burst).
 * - `swap-video` protects the signaling relay from being weaponized.
 * - `signaling` is shared across offer/answer/ice-candidate because a single
 *   negotiation legitimately produces many ICE candidates in quick succession.
 * - `safety` (block/unblock/report) is intentionally small — these are human
 *   actions, and flooding them is itself abuse.
 */
const rateLimiter = new RateLimiter({
  'match-request': { capacity: 5, refillPerSec: 1 },
  swipe: { capacity: 10, refillPerSec: 5 },
  'swap-video': { capacity: 3, refillPerSec: 0.5 },
  signaling: { capacity: 30, refillPerSec: 10 },
  safety: { capacity: 3, refillPerSec: 0.2 }
});
/** Per-session MoodEngine instances to avoid shared mutable state. */
const sessionEngines = new Map<string, MoodEngine>();
const clients = new Map<string, ClientState>();

function sendSafe(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

/**
 * Consume a rate-limit token for `(clientId, action)`. On rejection, sends a
 * structured `rate-limited` frame back to the client and returns false so the
 * caller can short-circuit without further processing.
 */
function checkRate(socket: WebSocket, clientId: string, action: string): boolean {
  const decision = rateLimiter.consume(clientId, action);
  if (!decision.allowed) {
    sendSafe(socket, {
      type: 'rate-limited',
      action,
      retryAfterMs: decision.retryAfterMs,
      remaining: decision.remaining
    });
    return false;
  }
  return true;
}

function terminateClient(clientId: string, reason: string): void {
  const state = clients.get(clientId);
  if (!state) return;

  sendSafe(state.socket, { type: 'terminated', reason, terminatedAt: Date.now() });
  state.socket.close(1008, reason);
  clients.delete(clientId);
}

function getSessionEngine(sessionId: string): MoodEngine | null {
  return sessionEngines.get(sessionId) ?? null;
}

/** Sync the latest ELO record from the service into a UserProfile copy. */
function syncEloToProfile(profile: UserProfile): UserProfile {
  const elo = eloService.getRecord(profile.id);
  return { ...profile, eloRating: elo.rating, interactionCount: elo.interactionCount };
}

app.register(websocket);

app.get('/health', async () => ({ status: 'ok' }));

// ─── Trust & Safety REST routes ──────────────────────────────────────────────

/** Block another user. Bidirectional for matchmaking / signaling. */
app.post<{
  Body: { blockerId: string; subjectId: string };
}>('/safety/block', async (request, reply) => {
  const { blockerId, subjectId } = request.body ?? {};
  if (!blockerId || !subjectId) {
    return reply.status(400).send({ error: 'blockerId and subjectId are required' });
  }
  const changed = safetyService.block(blockerId, subjectId);
  return { changed, blocks: safetyService.listBlocks(blockerId) };
});

/** Remove an explicit block. Does not clear site-wide auto-blocks. */
app.post<{
  Body: { blockerId: string; subjectId: string };
}>('/safety/unblock', async (request, reply) => {
  const { blockerId, subjectId } = request.body ?? {};
  if (!blockerId || !subjectId) {
    return reply.status(400).send({ error: 'blockerId and subjectId are required' });
  }
  const changed = safetyService.unblock(blockerId, subjectId);
  return { changed, blocks: safetyService.listBlocks(blockerId) };
});

/** Record an abuse report; may trigger an auto-block once threshold is met. */
app.post<{
  Body: { reporterId: string; subjectId: string; reason: ReportReason; note?: string };
}>('/safety/report', async (request, reply) => {
  const { reporterId, subjectId, reason, note } = request.body ?? ({} as {
    reporterId?: string;
    subjectId?: string;
    reason?: ReportReason;
    note?: string;
  });
  if (!reporterId || !subjectId || !reason) {
    return reply.status(400).send({ error: 'reporterId, subjectId and reason are required' });
  }
  const record = safetyService.report({ reporterId, subjectId, reason, note });
  return {
    accepted: record !== null,
    reportCount: safetyService.reportCount(subjectId),
    autoBlocked: safetyService.isAutoBlocked(subjectId)
  };
});

/** List explicit blocks for a user. */
app.get<{ Params: { userId: string } }>('/safety/blocks/:userId', async (request, reply) => {
  const { userId } = request.params;
  if (!userId) return reply.status(400).send({ error: 'userId is required' });
  return { userId, blocks: safetyService.listBlocks(userId) };
});

// ─── ELO REST routes ─────────────────────────────────────────────────────────

/**
 * High-frequency swipe event ingestion endpoint.
 *
 * Designed to be placed behind a load balancer for batch throughput;
 * a Redis-backed EloRatingService can replace the in-memory store for
 * horizontal scaling to 100 k+ events per second.
 *
 * POST /elo/swipe
 * Body: { viewerId, subjectId, outcome: 'skip' | 'hold', featureKey?: string }
 */
app.post<{
  Body: { viewerId: string; subjectId: string; outcome: SwipeOutcome; featureKey?: string };
}>('/elo/swipe', async (request, reply) => {
  const { viewerId, subjectId, outcome, featureKey } = request.body;

  if (!viewerId || !subjectId || (outcome !== 'skip' && outcome !== 'hold')) {
    return reply.status(400).send({ error: 'viewerId, subjectId and outcome (skip|hold) are required' });
  }

  if (viewerId === subjectId) {
    return reply.status(400).send({ error: 'cannot swipe on self' });
  }

  const result = eloService.processSwipe(viewerId, subjectId, outcome);

  if (featureKey) {
    const reward = outcome === 'hold' ? 1 : -1;
    hiveMind.reinforce({ featureKey, reward });
  }

  return {
    viewerElo: result.viewerElo,
    subjectElo: result.subjectElo,
    outcome: result.outcome
  };
});

/** Return the ELO record (rating + bracket + interaction count) for a user. */
app.get<{ Params: { userId: string } }>('/elo/:userId', async (request, reply) => {
  const { userId } = request.params;
  if (!userId) return reply.status(400).send({ error: 'userId is required' });

  const record = eloService.getRecord(userId);
  return { ...record, bracket: eloService.getBracket(userId) };
});

// ─── Mood Engine REST routes ─────────────────────────────────────────────────

/** List all available moods (stateless – instantiate a temporary engine). */
app.get('/moods', async () => ({
  moods: new MoodEngine().listMoods()
}));

/** Start a new listening/watching session for a user and mood. */
app.post<{
  Body: { userId: string; mood: MoodName; isPremium?: boolean };
}>('/sessions', async (request, reply) => {
  const { userId, mood, isPremium = false } = request.body;

  if (!userId || !mood) {
    return reply.status(400).send({ error: 'userId and mood are required' });
  }

  const sessionId = randomUUID();
  const engine = new MoodEngine(mood);
  sessionEngines.set(sessionId, engine);
  const state = sessionTracker.createSession({ sessionId, userId, mood, isPremium });
  const track = engine.generateTrack(mood);

  return { session: state, track };
});

/** Tick a session forward by deltaSeconds; returns a paywall trigger if needed. */
app.post<{
  Params: { sessionId: string };
  Body: { deltaSeconds: number };
}>('/sessions/:sessionId/tick', async (request, reply) => {
  const { sessionId } = request.params;
  const { deltaSeconds } = request.body;

  if (typeof deltaSeconds !== 'number' || deltaSeconds <= 0) {
    return reply.status(400).send({ error: 'deltaSeconds must be a positive number' });
  }

  const paywall = sessionTracker.tick(sessionId, deltaSeconds);
  const session = sessionTracker.getSession(sessionId);

  if (!session) {
    return reply.status(404).send({ error: 'session-not-found' });
  }

  return { session, paywall: paywall ?? null };
});

/** Generate the next track variation (the "✨ Evolve Melody" button). */
app.post<{
  Params: { sessionId: string };
}>('/sessions/:sessionId/evolve', async (request, reply) => {
  const session = sessionTracker.getSession(request.params.sessionId);
  if (!session) {
    return reply.status(404).send({ error: 'session-not-found' });
  }

  const engine = getSessionEngine(request.params.sessionId);
  if (!engine) {
    return reply.status(500).send({ error: 'session-engine-not-found' });
  }

  const track = engine.evolveTrack();
  return { track };
});

/** BCI context evaluation – may trigger automatic mood transition. */
app.post<{
  Params: { sessionId: string };
  Body: { bciContext: BCIContext };
}>('/sessions/:sessionId/bci', async (request, reply) => {
  const session = sessionTracker.getSession(request.params.sessionId);
  if (!session) {
    return reply.status(404).send({ error: 'session-not-found' });
  }

  const engine = getSessionEngine(request.params.sessionId);
  if (!engine) {
    return reply.status(500).send({ error: 'session-engine-not-found' });
  }

  const transition = engine.evaluateBCIContext(request.body.bciContext);
  const track = engine.generateTrack();

  return { transition: transition ?? null, track };
});

/** Mock "Sync with Quantchat" – creates a watch/listen party. */
app.post<{
  Params: { sessionId: string };
}>('/sessions/:sessionId/quantchat-sync', async (request, reply) => {
  try {
    const result = sessionTracker.syncWithQuantchat(request.params.sessionId);
    return { sync: result };
  } catch {
    return reply.status(404).send({ error: 'session-not-found' });
  }
});

/** End a session and retrieve its final state. */
app.delete<{
  Params: { sessionId: string };
}>('/sessions/:sessionId', async (request, reply) => {
  const { sessionId } = request.params;
  sessionEngines.delete(sessionId);
  const state = sessionTracker.endSession(sessionId);
  if (!state) {
    return reply.status(404).send({ error: 'session-not-found' });
  }
  return { session: state };
});

app.get('/ws', { websocket: true }, (socket) => {
  const clientId = randomUUID();
  clients.set(clientId, {
    socket,
    connectedAt: Date.now(),
    authenticated: false
  });

  sendSafe(socket, { type: 'connected', clientId });

  socket.on('message', (raw: RawData) => {
    let message: SocketMessage;

    try {
      message = JSON.parse(String(raw)) as SocketMessage;
    } catch {
      sendSafe(socket, { type: 'error', message: 'invalid-json' });
      return;
    }

    const currentClient = clients.get(clientId);
    if (!currentClient) {
      return;
    }

    if (message.type === 'biometric-handshake') {
      const valid = handshakeService.validateInitialHandshake(message.payload);
      if (!valid) {
        terminateClient(clientId, 'biometric-handshake-failed');
        return;
      }

      currentClient.authenticated = true;
      sendSafe(socket, { type: 'biometric-handshake-accepted', acceptedAt: Date.now() });
      return;
    }

    if (!currentClient.authenticated) {
      sendSafe(socket, { type: 'error', message: 'biometric-handshake-required' });
      return;
    }

    if (message.type === 'biometric-update') {
      if (handshakeService.shouldTerminateForLiveness(message.payload)) {
        terminateClient(clientId, 'face-liveness-dropped');
        return;
      }

      sendSafe(socket, { type: 'biometric-ok', checkedAt: Date.now() });
      return;
    }

    if (message.type === 'register') {
      const eloRecord = eloService.getRecord(message.userId);
      currentClient.profile = {
        id: message.userId,
        interestGraph: message.interestGraph,
        eloRating: eloRecord.rating,
        interactionCount: eloRecord.interactionCount
      };

      sendSafe(socket, { type: 'registered', userId: message.userId });
      return;
    }

    if (message.type === 'match-request') {
      if (!currentClient.profile) {
        sendSafe(socket, { type: 'error', message: 'register-required' });
        return;
      }

      if (!checkRate(socket, clientId, 'match-request')) return;

      // Auto-blocked users cannot initiate matches.
      if (safetyService.isAutoBlocked(currentClient.profile.id)) {
        sendSafe(socket, { type: 'error', message: 'account-suspended' });
        return;
      }

      // Sync latest ELO into the profile before ranking.
      currentClient.profile = syncEloToProfile(currentClient.profile);

      const viewerId = currentClient.profile.id;
      const candidates = Array.from(clients.values())
        .filter((client) => client.authenticated && client.profile)
        .map((client) => syncEloToProfile(client.profile as UserProfile))
        .filter((candidate) => !safetyService.isBlocked(viewerId, candidate.id));

      const ranked = matchMaker.rankCandidates(currentClient.profile, candidates, message.bciContext);
      sendSafe(socket, {
        type: 'match-response',
        transitionLoop: matchMaker.shouldTransitionLoop(message.bciContext),
        candidates: ranked.slice(0, 5)
      });
      return;
    }

    if (message.type === 'swipe') {
      if (!currentClient.profile) {
        sendSafe(socket, { type: 'error', message: 'register-required' });
        return;
      }

      if (currentClient.profile.id === message.subjectUserId) {
        sendSafe(socket, { type: 'error', message: 'cannot swipe on self' });
        return;
      }

      if (!checkRate(socket, clientId, 'swipe')) return;

      // Do not record interactions that cross an explicit block — this would
      // leak information that the blocked user is still active.
      if (safetyService.isBlocked(currentClient.profile.id, message.subjectUserId)) {
        sendSafe(socket, { type: 'error', message: 'blocked' });
        return;
      }

      const result = eloService.processSwipe(currentClient.profile.id, message.subjectUserId, message.outcome);

      // Feed the outcome into the HiveMind reinforcement loop so that the
      // interest-graph weights converge toward features that hold attention.
      if (message.featureKey) {
        const reward = message.outcome === 'hold' ? 1 : -1;
        hiveMind.reinforce({ featureKey: message.featureKey, reward });
      }

      sendSafe(socket, {
        type: 'swipe-ack',
        outcome: result.outcome,
        viewerElo: result.viewerElo.rating,
        subjectElo: result.subjectElo.rating,
        processedAt: Date.now()
      });
      return;
    }

    if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
      if (!checkRate(socket, clientId, 'signaling')) return;

      const target = Array.from(clients.values()).find((client) => client.profile?.id === message.targetUserId);
      if (!target) {
        sendSafe(socket, { type: 'error', message: 'target-not-found' });
        return;
      }

      const fromId = currentClient.profile?.id;
      if (fromId && safetyService.isBlocked(fromId, message.targetUserId)) {
        sendSafe(socket, { type: 'error', message: 'blocked' });
        return;
      }

      sendSafe(target.socket, {
        type: message.type,
        fromUserId: fromId,
        payload: message.payload,
        relayedAt: Date.now()
      });

      return;
    }

    if (message.type === 'swap-video') {
      if (!checkRate(socket, clientId, 'swap-video')) return;

      const startedAt = message.startedAt ?? Date.now();
      const now = Date.now();
      const relayLatencyMs = Math.max(0, now - startedAt);
      const target = Array.from(clients.values()).find((client) => client.profile?.id === message.targetUserId);

      if (!target) {
        sendSafe(socket, { type: 'error', message: 'target-not-found' });
        return;
      }

      const fromId = currentClient.profile?.id;
      if (fromId && safetyService.isBlocked(fromId, message.targetUserId)) {
        sendSafe(socket, { type: 'error', message: 'blocked' });
        return;
      }

      sendSafe(target.socket, {
        type: 'swap-video',
        fromUserId: fromId,
        requestId: message.requestId ?? randomUUID(),
        startedAt,
        relayedAt: now,
        relayLatencyMs,
        under200ms: relayLatencyMs < 200
      });

      sendSafe(socket, {
        type: 'swap-video-ack',
        requestId: message.requestId,
        relayLatencyMs,
        under200ms: relayLatencyMs < 200
      });
      return;
    }

    if (message.type === 'block' || message.type === 'unblock' || message.type === 'report') {
      if (!currentClient.profile) {
        sendSafe(socket, { type: 'error', message: 'register-required' });
        return;
      }
      if (!checkRate(socket, clientId, 'safety')) return;

      const actorId = currentClient.profile.id;
      if (!message.subjectUserId || message.subjectUserId === actorId) {
        sendSafe(socket, { type: 'error', message: 'invalid-subject' });
        return;
      }

      if (message.type === 'block') {
        const changed = safetyService.block(actorId, message.subjectUserId);
        sendSafe(socket, { type: 'block-ack', subjectUserId: message.subjectUserId, changed });
      } else if (message.type === 'unblock') {
        const changed = safetyService.unblock(actorId, message.subjectUserId);
        sendSafe(socket, { type: 'unblock-ack', subjectUserId: message.subjectUserId, changed });
      } else {
        const record = safetyService.report({
          reporterId: actorId,
          subjectId: message.subjectUserId,
          reason: message.reason,
          note: message.note
        });
        sendSafe(socket, {
          type: 'report-ack',
          subjectUserId: message.subjectUserId,
          accepted: record !== null,
          autoBlocked: safetyService.isAutoBlocked(message.subjectUserId)
        });
      }
      return;
    }

    if (message.type === 'ping') {
      sendSafe(socket, { type: 'pong', sentAt: message.sentAt ?? Date.now(), receivedAt: Date.now() });
    }
  });

  socket.on('close', () => {
    clients.delete(clientId);
    rateLimiter.reset(clientId);
  });
});

const start = async (): Promise<void> => {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
};

if (require.main === module) {
  start().catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app, start };
