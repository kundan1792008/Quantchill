export interface InteractionEvent {
  userId: string;
  peerId: string;
  occurredAtMs: number;
  /** Session dwell time in ms. */
  timeSpentMs: number;
  /** Message count exchanged in this interaction. */
  messageCount: number;
  /** Average words per message for this interaction. */
  averageWordsPerMessage: number;
  /** Number of back-and-forth turns. */
  conversationTurns: number;
  /** True when the interaction was a sustained conversation. */
  sustainedConversation: boolean;
}

export interface PersonalityMatrix {
  userId: string;
  updatedAtMs: number;
  interactionCount24h: number;
  averageTimeSpentMs: number;
  conversationDepth: number;
  sustainedConversationRate: number;
  responsiveness: number;
  consistency: number;
  embedding: number[];
}

export interface CompatibilityEdge {
  sourceUserId: string;
  targetUserId: string;
  score: number;
  updatedAtMs: number;
}

export interface CompatibilityGraph {
  generatedAtMs: number;
  edges: CompatibilityEdge[];
}

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return clamp(value / max, 0, 1);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let lMag = 0;
  let rMag = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    lMag += l * l;
    rMag += r * r;
  }

  if (lMag === 0 || rMag === 0) return 0;
  return clamp(dot / (Math.sqrt(lMag) * Math.sqrt(rMag)), 0, 1);
}

export class ResonanceAnalyzer {
  constructor(
    private readonly nowFn: () => number = () => Date.now(),
    private readonly rollingWindowMs = ROLLING_WINDOW_MS
  ) {}

  filterToRollingWindow(events: readonly InteractionEvent[], referenceMs = this.nowFn()): InteractionEvent[] {
    const cutoff = referenceMs - this.rollingWindowMs;
    return events.filter((event) => event.occurredAtMs >= cutoff && event.occurredAtMs <= referenceMs);
  }

  buildPersonalityMatrix(userId: string, events: readonly InteractionEvent[]): PersonalityMatrix {
    const userEvents = events.filter((event) => event.userId === userId || event.peerId === userId);

    if (userEvents.length === 0) {
      return {
        userId,
        updatedAtMs: this.nowFn(),
        interactionCount24h: 0,
        averageTimeSpentMs: 0,
        conversationDepth: 0,
        sustainedConversationRate: 0,
        responsiveness: 0,
        consistency: 0,
        embedding: [0, 0, 0, 0, 0]
      };
    }

    const interactionCount24h = userEvents.length;
    const totalTime = userEvents.reduce((sum, event) => sum + Math.max(0, event.timeSpentMs), 0);
    const totalMessageCount = userEvents.reduce((sum, event) => sum + Math.max(0, event.messageCount), 0);
    const totalWordsPerMessage = userEvents.reduce(
      (sum, event) => sum + Math.max(0, event.averageWordsPerMessage),
      0
    );
    const totalTurns = userEvents.reduce((sum, event) => sum + Math.max(0, event.conversationTurns), 0);
    const sustainedCount = userEvents.reduce((sum, event) => sum + (event.sustainedConversation ? 1 : 0), 0);

    const averageTimeSpentMs = totalTime / interactionCount24h;
    const averageMessageCount = totalMessageCount / interactionCount24h;
    const averageWordsPerMessage = totalWordsPerMessage / interactionCount24h;
    const averageTurns = totalTurns / interactionCount24h;

    // Conversation depth combines turns, verbosity, and message count.
    const conversationDepth = clamp(
      averageTurns * 0.45 + averageWordsPerMessage * 0.35 + averageMessageCount * 0.2,
      0,
      100
    );

    // Responsiveness proxy: more turns in less time indicates tighter conversational cadence.
    const responsiveness = clamp((averageTurns * 60_000) / Math.max(1, averageTimeSpentMs), 0, 1);

    const sustainedConversationRate = clamp(sustainedCount / interactionCount24h, 0, 1);

    // Consistency from normalized standard deviation of session durations.
    const meanDuration = averageTimeSpentMs;
    const variance =
      userEvents.reduce((sum, event) => {
        const delta = Math.max(0, event.timeSpentMs) - meanDuration;
        return sum + delta * delta;
      }, 0) / interactionCount24h;
    const stdDev = Math.sqrt(variance);
    const consistency = 1 - clamp(stdDev / Math.max(1, meanDuration), 0, 1);

    const embedding = [
      normalize(averageTimeSpentMs, 20 * 60_000),
      normalize(conversationDepth, 100),
      sustainedConversationRate,
      responsiveness,
      consistency
    ].map((value) => Number(value.toFixed(4)));

    return {
      userId,
      updatedAtMs: this.nowFn(),
      interactionCount24h,
      averageTimeSpentMs: Number(averageTimeSpentMs.toFixed(2)),
      conversationDepth: Number(conversationDepth.toFixed(2)),
      sustainedConversationRate: Number(sustainedConversationRate.toFixed(4)),
      responsiveness: Number(responsiveness.toFixed(4)),
      consistency: Number(consistency.toFixed(4)),
      embedding
    };
  }

  buildCompatibilityGraph(userIds: readonly string[], events: readonly InteractionEvent[]): CompatibilityGraph {
    const matrices = new Map<string, PersonalityMatrix>();
    for (const userId of userIds) {
      matrices.set(userId, this.buildPersonalityMatrix(userId, events));
    }

    const generatedAtMs = this.nowFn();
    const edges: CompatibilityEdge[] = [];

    for (const sourceUserId of userIds) {
      for (const targetUserId of userIds) {
        if (sourceUserId === targetUserId) continue;

        const source = matrices.get(sourceUserId);
        const target = matrices.get(targetUserId);
        if (!source || !target) continue;

        const similarity = cosineSimilarity(source.embedding, target.embedding);
        edges.push({
          sourceUserId,
          targetUserId,
          score: Number((similarity * 100).toFixed(2)),
          updatedAtMs: generatedAtMs
        });
      }
    }

    return {
      generatedAtMs,
      edges
    };
  }

  updateRollingGraph(userIds: readonly string[], events: readonly InteractionEvent[]): CompatibilityGraph {
    const inWindow = this.filterToRollingWindow(events);
    return this.buildCompatibilityGraph(userIds, inWindow);
  }
}
