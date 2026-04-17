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

type SocketMessage =
  | { type: 'register'; userId: string; interestGraph: Record<string, number>; bciContext?: BCIContext }
  | { type: 'offer' | 'answer' | 'ice-candidate'; targetUserId: string; payload: unknown }
  | { type: 'swap-video'; targetUserId: string; requestId?: string; startedAt?: number }
  | { type: 'biometric-handshake'; payload: BiometricPayload }
  | { type: 'biometric-update'; payload: BiometricPayload }
  | { type: 'match-request'; bciContext: BCIContext }
  | { type: 'swipe'; subjectUserId: string; outcome: SwipeOutcome; featureKey?: string }
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
/** Per-session MoodEngine instances to avoid shared mutable state. */
const sessionEngines = new Map<string, MoodEngine>();
const clients = new Map<string, ClientState>();

function sendSafe(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
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

      // Sync latest ELO into the profile before ranking.
      currentClient.profile = syncEloToProfile(currentClient.profile);

      const candidates = Array.from(clients.values())
        .filter((client) => client.authenticated && client.profile)
        .map((client) => syncEloToProfile(client.profile as UserProfile));

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
      const target = Array.from(clients.values()).find((client) => client.profile?.id === message.targetUserId);
      if (!target) {
        sendSafe(socket, { type: 'error', message: 'target-not-found' });
        return;
      }

      sendSafe(target.socket, {
        type: message.type,
        fromUserId: currentClient.profile?.id,
        payload: message.payload,
        relayedAt: Date.now()
      });

      return;
    }

    if (message.type === 'swap-video') {
      const startedAt = message.startedAt ?? Date.now();
      const now = Date.now();
      const relayLatencyMs = Math.max(0, now - startedAt);
      const target = Array.from(clients.values()).find((client) => client.profile?.id === message.targetUserId);

      if (!target) {
        sendSafe(socket, { type: 'error', message: 'target-not-found' });
        return;
      }

      sendSafe(target.socket, {
        type: 'swap-video',
        fromUserId: currentClient.profile?.id,
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

    if (message.type === 'ping') {
      sendSafe(socket, { type: 'pong', sentAt: message.sentAt ?? Date.now(), receivedAt: Date.now() });
    }
  });

  socket.on('close', () => {
    clients.delete(clientId);
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
