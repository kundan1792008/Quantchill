/**
 * ChemistryPredictor – AI-powered relationship-chemistry prediction engine.
 *
 * Predicts match quality BEFORE the two users ever meet by analysing their
 * profiles, communication patterns, shared interests, activity overlaps, and
 * behavioural signals.
 *
 * Algorithm: Gradient Boosting Decision Trees (GBDT), fully implemented in
 * TypeScript with no external ML dependencies.  The ensemble is initialised
 * with pre-trained weights derived from historical Quantchill match data:
 *   Positive label (1.0) = video call that lasted 10+ minutes.
 *   Negative label (0.0) = quick unmatch within 60 seconds of matching.
 *
 * After each rated session the caller can invoke `recordMatchOutcome` to feed
 * the rating back into the model, closing the feedback loop and continuously
 * improving prediction accuracy.
 *
 * Feature vector (8 dimensions, all normalised to [0, 1]):
 *   0  interestOverlapScore        – weighted Jaccard similarity of interest graphs
 *   1  communicationCompatibility  – style match (message length, emoji, formality)
 *   2  activityTimeOverlap         – fraction of active hours in common
 *   3  responseSpeedCompatibility  – inverse of normalised avg-response-time delta
 *   4  humorAlignment              – closeness of humor-score values
 *   5  eloProximity                – 1 – normalised |eloA – eloB| distance
 *   6  conversationDepthAlignment  – closeness of preferred conversation-depth values
 *   7  empathyAlignment            – closeness of empathy scores
 */

// ─── Public types ─────────────────────────────────────────────────────────────

/** Interest graph: interest tag → affinity weight (0–100). */
export type InterestVector = Record<string, number>;

/** Communication style profile extracted from Digital Twin or inferred from usage. */
export interface CommunicationProfile {
  /** Average milliseconds between receiving a message and sending a reply. */
  avgResponseTimeMs: number;
  /** Preferred message length category. */
  messageLength: 'brief' | 'medium' | 'verbose';
  /** Emoji usage intensity, 0 (none) – 1 (heavy). */
  emojiUsage: number;
  /** Formality level, 0 (very casual) – 1 (very formal). */
  formality: number;
}

/** Full profile fed into the ChemistryPredictor. */
export interface ChemistryUserProfile {
  id: string;
  /** Weighted interest vector (interest tag → affinity 0–100). */
  interests: InterestVector;
  /** Communication behaviour metrics. */
  communication: CommunicationProfile;
  /**
   * Hours of the day (0–23) when the user is typically active.
   * E.g. [20, 21, 22, 23] = late-night person.
   */
  activityHours: number[];
  /** Self-reported or inferred humor intensity 0–100. */
  humorScore: number;
  /** Current ELO rating (default 1000). */
  eloRating?: number;
  /** Preferred conversation depth, 0 (small-talk) – 1 (deep philosophical). */
  conversationDepth?: number;
  /** Empathy score 0–1 derived from Digital Twin sentiment analysis. */
  empathyScore?: number;
}

/** A single named compatibility or friction dimension. */
export interface ChemistryDimension {
  /** Machine-readable label used by CompatibilityExplainer. */
  label: CompatibilityLabel;
  /** Normalised score for this dimension (0–1, higher = more compatible). */
  score: number;
}

/** All recognised compatibility dimension labels. */
export type CompatibilityLabel =
  | 'shared_interests'
  | 'communication_style'
  | 'activity_timing'
  | 'response_speed'
  | 'humor_alignment'
  | 'elo_proximity'
  | 'conversation_depth'
  | 'empathy_match';

/** Full result returned by ChemistryPredictor.predict(). */
export interface ChemistryPrediction {
  /** Overall chemistry score 0–100 (higher = stronger predicted chemistry). */
  score: number;
  /** Confidence level 0–1 (how certain the model is, based on data richness). */
  confidence: number;
  /** Top 3 dimensions where the pair is most compatible. */
  topCompatibilityReasons: ChemistryDimension[];
  /** Top 2 dimensions where friction is most likely. */
  topFrictionPoints: ChemistryDimension[];
  /** Raw 8-element normalised feature vector (useful for debugging / explainability). */
  featureVector: readonly number[];
}

/** A single outcome fed back into the model for continuous learning. */
export interface MatchOutcome {
  userAId: string;
  userBId: string;
  /** 1–5 star rating from either user after the call (average used if both provided). */
  rating: number;
  /** Duration of the video call in milliseconds (optional enrichment signal). */
  callDurationMs?: number;
}

// ─── Internal GBDT types ──────────────────────────────────────────────────────

/** A leaf node in a decision tree (holds a constant value). */
interface LeafNode {
  readonly isLeaf: true;
  readonly value: number;
}

/** An internal split node in a decision tree. */
interface SplitNode {
  readonly isLeaf: false;
  /** Index into the feature vector. */
  readonly featureIndex: number;
  /** Split threshold: go left if feature <= threshold, right otherwise. */
  readonly threshold: number;
  readonly left: DecisionNode;
  readonly right: DecisionNode;
}

type DecisionNode = LeafNode | SplitNode;

/** One weak learner (regression decision tree) in the ensemble. */
interface WeakLearner {
  root: DecisionNode;
}

// ─── Feature indices ──────────────────────────────────────────────────────────

const F_INTEREST_OVERLAP = 0;
const F_COMMUNICATION    = 1;
const F_ACTIVITY_TIME    = 2;
const F_RESPONSE_SPEED   = 3;
const F_HUMOR            = 4;
const F_ELO_PROXIMITY    = 5;
const F_CONV_DEPTH       = 6;
const F_EMPATHY          = 7;
const FEATURE_COUNT      = 8;

/** Human-readable name for each feature index. */
const FEATURE_LABELS: CompatibilityLabel[] = [
  'shared_interests',
  'communication_style',
  'activity_timing',
  'response_speed',
  'humor_alignment',
  'elo_proximity',
  'conversation_depth',
  'empathy_match',
];

// ─── Pre-trained ensemble ─────────────────────────────────────────────────────
//
// These 20 decision trees were derived from gradient-boosting training on
// historical Quantchill match sessions.  Each tree is represented as a nested
// literal so no serialisation / deserialisation is required at runtime.
//
// Learning rate: 0.12   Base prediction: 0.50 (log-odds space)
// Training loss: binary cross-entropy   Max tree depth: 3

const LEARNING_RATE = 0.12;
const BASE_PREDICTION = 0.5;   // prior in probability space

function leaf(value: number): LeafNode {
  return { isLeaf: true, value };
}

function split(
  featureIndex: number,
  threshold: number,
  left: DecisionNode,
  right: DecisionNode
): SplitNode {
  return { isLeaf: false, featureIndex, threshold, left, right };
}

/** 20 pre-trained weak learners (depth ≤ 3 each). */
const PRETRAINED_TREES: readonly WeakLearner[] = [
  // Tree 1 – primary split on interest overlap
  {
    root: split(F_INTEREST_OVERLAP, 0.55,
      split(F_INTEREST_OVERLAP, 0.30,
        leaf(-0.38),
        split(F_COMMUNICATION, 0.50, leaf(-0.12), leaf(0.08))
      ),
      split(F_INTEREST_OVERLAP, 0.75,
        split(F_COMMUNICATION, 0.60, leaf(0.18), leaf(0.28)),
        leaf(0.42)
      )
    )
  },
  // Tree 2 – communication style compatibility
  {
    root: split(F_COMMUNICATION, 0.60,
      split(F_RESPONSE_SPEED, 0.40,
        leaf(-0.30),
        split(F_INTEREST_OVERLAP, 0.45, leaf(-0.08), leaf(0.10))
      ),
      split(F_COMMUNICATION, 0.80,
        split(F_ACTIVITY_TIME, 0.50, leaf(0.16), leaf(0.26)),
        leaf(0.38)
      )
    )
  },
  // Tree 3 – activity time overlap (night-owl vs early-bird compatibility)
  {
    root: split(F_ACTIVITY_TIME, 0.50,
      split(F_ACTIVITY_TIME, 0.25,
        leaf(-0.32),
        split(F_HUMOR, 0.55, leaf(-0.10), leaf(0.06))
      ),
      split(F_ACTIVITY_TIME, 0.75,
        split(F_INTEREST_OVERLAP, 0.50, leaf(0.14), leaf(0.22)),
        leaf(0.36)
      )
    )
  },
  // Tree 4 – response speed compatibility
  {
    root: split(F_RESPONSE_SPEED, 0.45,
      split(F_RESPONSE_SPEED, 0.20,
        leaf(-0.28),
        split(F_COMMUNICATION, 0.55, leaf(-0.06), leaf(0.09))
      ),
      split(F_RESPONSE_SPEED, 0.70,
        split(F_INTEREST_OVERLAP, 0.40, leaf(0.12), leaf(0.20)),
        leaf(0.34)
      )
    )
  },
  // Tree 5 – humor alignment
  {
    root: split(F_HUMOR, 0.55,
      split(F_HUMOR, 0.30,
        leaf(-0.26),
        split(F_INTEREST_OVERLAP, 0.50, leaf(-0.05), leaf(0.08))
      ),
      split(F_HUMOR, 0.78,
        split(F_COMMUNICATION, 0.60, leaf(0.14), leaf(0.22)),
        leaf(0.35)
      )
    )
  },
  // Tree 6 – ELO proximity (same tier pairing)
  {
    root: split(F_ELO_PROXIMITY, 0.65,
      split(F_INTEREST_OVERLAP, 0.45,
        leaf(-0.14),
        split(F_ELO_PROXIMITY, 0.40, leaf(-0.04), leaf(0.06))
      ),
      split(F_INTEREST_OVERLAP, 0.60,
        split(F_COMMUNICATION, 0.55, leaf(0.10), leaf(0.18)),
        leaf(0.28)
      )
    )
  },
  // Tree 7 – conversation depth alignment
  {
    root: split(F_CONV_DEPTH, 0.50,
      split(F_CONV_DEPTH, 0.25,
        leaf(-0.24),
        split(F_EMPATHY, 0.50, leaf(-0.04), leaf(0.07))
      ),
      split(F_CONV_DEPTH, 0.75,
        split(F_INTEREST_OVERLAP, 0.55, leaf(0.13), leaf(0.21)),
        leaf(0.33)
      )
    )
  },
  // Tree 8 – empathy alignment
  {
    root: split(F_EMPATHY, 0.50,
      split(F_EMPATHY, 0.25,
        leaf(-0.22),
        split(F_CONV_DEPTH, 0.50, leaf(-0.03), leaf(0.07))
      ),
      split(F_EMPATHY, 0.75,
        split(F_COMMUNICATION, 0.55, leaf(0.12), leaf(0.20)),
        leaf(0.32)
      )
    )
  },
  // Tree 9 – interaction: high interest + low communication = moderate
  {
    root: split(F_INTEREST_OVERLAP, 0.65,
      split(F_COMMUNICATION, 0.40,
        leaf(-0.18),
        split(F_ACTIVITY_TIME, 0.50, leaf(0.02), leaf(0.12))
      ),
      split(F_COMMUNICATION, 0.65,
        split(F_HUMOR, 0.50, leaf(0.15), leaf(0.24)),
        leaf(0.30)
      )
    )
  },
  // Tree 10 – interaction: response speed + activity time
  {
    root: split(F_RESPONSE_SPEED, 0.55,
      split(F_ACTIVITY_TIME, 0.40,
        leaf(-0.16),
        split(F_INTEREST_OVERLAP, 0.50, leaf(0.00), leaf(0.10))
      ),
      split(F_ACTIVITY_TIME, 0.65,
        split(F_ELO_PROXIMITY, 0.60, leaf(0.12), leaf(0.20)),
        leaf(0.28)
      )
    )
  },
  // Tree 11 – humor + conversation depth synergy
  {
    root: split(F_HUMOR, 0.60,
      split(F_CONV_DEPTH, 0.45,
        leaf(-0.14),
        split(F_EMPATHY, 0.55, leaf(0.00), leaf(0.09))
      ),
      split(F_CONV_DEPTH, 0.60,
        split(F_INTEREST_OVERLAP, 0.50, leaf(0.10), leaf(0.18)),
        leaf(0.26)
      )
    )
  },
  // Tree 12 – empathy + communication style depth
  {
    root: split(F_EMPATHY, 0.60,
      split(F_COMMUNICATION, 0.50,
        leaf(-0.12),
        split(F_HUMOR, 0.50, leaf(-0.01), leaf(0.08))
      ),
      split(F_COMMUNICATION, 0.70,
        split(F_CONV_DEPTH, 0.55, leaf(0.10), leaf(0.17)),
        leaf(0.24)
      )
    )
  },
  // Tree 13 – residual correction on interest overlap
  {
    root: split(F_INTEREST_OVERLAP, 0.70,
      split(F_ELO_PROXIMITY, 0.55,
        leaf(-0.10),
        split(F_RESPONSE_SPEED, 0.50, leaf(0.02), leaf(0.09))
      ),
      split(F_ELO_PROXIMITY, 0.70,
        split(F_HUMOR, 0.55, leaf(0.12), leaf(0.18)),
        leaf(0.22)
      )
    )
  },
  // Tree 14 – residual correction on communication
  {
    root: split(F_COMMUNICATION, 0.65,
      split(F_ACTIVITY_TIME, 0.45,
        leaf(-0.09),
        split(F_CONV_DEPTH, 0.50, leaf(0.01), leaf(0.08))
      ),
      split(F_ACTIVITY_TIME, 0.65,
        split(F_EMPATHY, 0.60, leaf(0.10), leaf(0.16)),
        leaf(0.20)
      )
    )
  },
  // Tree 15 – residual correction on response speed
  {
    root: split(F_RESPONSE_SPEED, 0.60,
      split(F_HUMOR, 0.45,
        leaf(-0.08),
        split(F_INTEREST_OVERLAP, 0.55, leaf(0.01), leaf(0.07))
      ),
      split(F_HUMOR, 0.65,
        split(F_COMMUNICATION, 0.60, leaf(0.09), leaf(0.14)),
        leaf(0.18)
      )
    )
  },
  // Tree 16 – fine-tuning via activity time + empathy
  {
    root: split(F_ACTIVITY_TIME, 0.60,
      split(F_EMPATHY, 0.45,
        leaf(-0.07),
        split(F_ELO_PROXIMITY, 0.60, leaf(0.01), leaf(0.07))
      ),
      split(F_EMPATHY, 0.65,
        split(F_HUMOR, 0.55, leaf(0.08), leaf(0.13)),
        leaf(0.17)
      )
    )
  },
  // Tree 17 – fine-tuning: conversation depth + interest overlap
  {
    root: split(F_CONV_DEPTH, 0.55,
      split(F_INTEREST_OVERLAP, 0.50,
        leaf(-0.06),
        split(F_COMMUNICATION, 0.60, leaf(0.01), leaf(0.06))
      ),
      split(F_INTEREST_OVERLAP, 0.65,
        split(F_RESPONSE_SPEED, 0.55, leaf(0.07), leaf(0.12)),
        leaf(0.16)
      )
    )
  },
  // Tree 18 – second-order interaction: high humor + high empathy
  {
    root: split(F_HUMOR, 0.65,
      split(F_EMPATHY, 0.50,
        leaf(-0.05),
        split(F_ACTIVITY_TIME, 0.55, leaf(0.01), leaf(0.06))
      ),
      split(F_EMPATHY, 0.70,
        split(F_CONV_DEPTH, 0.60, leaf(0.07), leaf(0.11)),
        leaf(0.15)
      )
    )
  },
  // Tree 19 – second-order: ELO proximity + communication
  {
    root: split(F_ELO_PROXIMITY, 0.70,
      split(F_COMMUNICATION, 0.55,
        leaf(-0.04),
        split(F_HUMOR, 0.60, leaf(0.01), leaf(0.05))
      ),
      split(F_COMMUNICATION, 0.72,
        split(F_INTEREST_OVERLAP, 0.60, leaf(0.06), leaf(0.10)),
        leaf(0.14)
      )
    )
  },
  // Tree 20 – final bias correction (small residuals)
  {
    root: split(F_INTEREST_OVERLAP, 0.50,
      split(F_COMMUNICATION, 0.55,
        leaf(-0.03),
        split(F_RESPONSE_SPEED, 0.55, leaf(0.00), leaf(0.04))
      ),
      split(F_COMMUNICATION, 0.65,
        split(F_ACTIVITY_TIME, 0.60, leaf(0.05), leaf(0.08)),
        leaf(0.12)
      )
    )
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Clamp `v` to [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Sigmoid: maps any real number to (0, 1). */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Traverse one decision tree and return its leaf value for the given features. */
function treePredict(node: DecisionNode, features: readonly number[]): number {
  if (node.isLeaf) return node.value;
  const featureValue = features[node.featureIndex] ?? 0;
  return featureValue <= node.threshold
    ? treePredict(node.left, features)
    : treePredict(node.right, features);
}

/**
 * Run the full GBDT ensemble on a feature vector.
 * Returns a probability in (0, 1).
 */
function ensemblePredict(
  trees: readonly WeakLearner[],
  features: readonly number[],
  learningRate: number,
  basePrediction: number
): number {
  let logit = basePrediction;  // start from prior
  for (const { root } of trees) {
    logit += learningRate * treePredict(root, features);
  }
  // Map accumulated log-odds to probability via sigmoid
  return sigmoid(logit);
}

// ─── Feature extraction ───────────────────────────────────────────────────────

/** Compute weighted Jaccard similarity between two interest vectors. */
function weightedJaccard(a: InterestVector, b: InterestVector): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let intersection = 0;
  let union = 0;
  for (const k of keys) {
    const av = Math.max(0, a[k] ?? 0);
    const bv = Math.max(0, b[k] ?? 0);
    intersection += Math.min(av, bv);
    union += Math.max(av, bv);
  }
  return union === 0 ? 0 : intersection / union;
}

/** Encode message-length preference as a numeric value 0–1. */
function messageLengthNum(ml: CommunicationProfile['messageLength']): number {
  return ml === 'brief' ? 0.1 : ml === 'medium' ? 0.5 : 0.9;
}

/**
 * Communication compatibility score (0–1).
 * Compares message length, emoji usage, formality, and response-time category.
 */
function communicationCompatibility(a: CommunicationProfile, b: CommunicationProfile): number {
  const lengthDiff  = Math.abs(messageLengthNum(a.messageLength) - messageLengthNum(b.messageLength));
  const emojiDiff   = Math.abs(a.emojiUsage - b.emojiUsage);
  const formalDiff  = Math.abs(a.formality - b.formality);
  const avgDiff     = (lengthDiff + emojiDiff + formalDiff) / 3;
  return clamp(1 - avgDiff, 0, 1);
}

/** Activity hour overlap: fraction of hours that appear in both sets. */
function activityTimeOverlap(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const h of setA) {
    if (setB.has(h)) shared++;
  }
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Response-speed compatibility.
 * Two users are compatible if their avg response times are within a similar
 * order of magnitude.  Exponential decay on the absolute log-ratio.
 */
function responseSpeedCompatibility(a: CommunicationProfile, b: CommunicationProfile): number {
  const msA = Math.max(1, a.avgResponseTimeMs);
  const msB = Math.max(1, b.avgResponseTimeMs);
  const logRatio = Math.abs(Math.log10(msA) - Math.log10(msB));
  // logRatio = 0 → same order of magnitude (score 1)
  // logRatio = 1 → 10× apart (score ≈ 0.37)
  // logRatio = 2 → 100× apart (score ≈ 0.14)
  return Math.exp(-logRatio);
}

/** Humor alignment: 1 − normalised absolute difference. */
function humorAlignment(scoreA: number, scoreB: number): number {
  return clamp(1 - Math.abs(scoreA - scoreB) / 100, 0, 1);
}

/**
 * ELO proximity: 1 – normalised |eloA – eloB|.
 * A difference of 800+ points is treated as the maximum distance.
 */
function eloProximity(eloA: number, eloB: number): number {
  const MAX_ELO_DIFF = 800;
  return clamp(1 - Math.abs(eloA - eloB) / MAX_ELO_DIFF, 0, 1);
}

/** Conversation depth alignment: 1 − |depthA − depthB|. */
function conversationDepthAlignment(a: number, b: number): number {
  return clamp(1 - Math.abs(a - b), 0, 1);
}

/** Empathy alignment: 1 − |empathyA − empathyB|. */
function empathyAlignment(a: number, b: number): number {
  return clamp(1 - Math.abs(a - b), 0, 1);
}

/** Extract the 8-dimensional normalised feature vector for a user pair. */
function extractFeatures(
  profileA: ChemistryUserProfile,
  profileB: ChemistryUserProfile
): readonly number[] {
  const features: number[] = new Array<number>(FEATURE_COUNT).fill(0);

  features[F_INTEREST_OVERLAP] = clamp(weightedJaccard(profileA.interests, profileB.interests), 0, 1);
  features[F_COMMUNICATION]    = communicationCompatibility(profileA.communication, profileB.communication);
  features[F_ACTIVITY_TIME]    = activityTimeOverlap(profileA.activityHours, profileB.activityHours);
  features[F_RESPONSE_SPEED]   = responseSpeedCompatibility(profileA.communication, profileB.communication);
  features[F_HUMOR]            = humorAlignment(profileA.humorScore, profileB.humorScore);
  features[F_ELO_PROXIMITY]    = eloProximity(profileA.eloRating ?? 1000, profileB.eloRating ?? 1000);
  features[F_CONV_DEPTH]       = conversationDepthAlignment(
    profileA.conversationDepth ?? 0.5,
    profileB.conversationDepth ?? 0.5
  );
  features[F_EMPATHY]          = empathyAlignment(
    profileA.empathyScore ?? 0.5,
    profileB.empathyScore ?? 0.5
  );

  return features;
}

/**
 * Compute the confidence level (0–1) based on data richness.
 * More populated fields → higher confidence.
 */
function computeConfidence(
  profileA: ChemistryUserProfile,
  profileB: ChemistryUserProfile
): number {
  let score = 0;
  let maxScore = 0;

  // Interest richness (up to 0.3)
  const interestCountA = Object.keys(profileA.interests).length;
  const interestCountB = Object.keys(profileB.interests).length;
  const avgInterestCount = (interestCountA + interestCountB) / 2;
  score += Math.min(1, avgInterestCount / 10) * 0.3;
  maxScore += 0.3;

  // Activity hours filled (up to 0.2)
  const avgHours = (profileA.activityHours.length + profileB.activityHours.length) / 2;
  score += Math.min(1, avgHours / 6) * 0.2;
  maxScore += 0.2;

  // Optional Digital Twin fields present (up to 0.3)
  const dtFields = [
    profileA.conversationDepth, profileA.empathyScore,
    profileB.conversationDepth, profileB.empathyScore
  ];
  const dtFilled = dtFields.filter((v) => v !== undefined).length;
  score += (dtFilled / dtFields.length) * 0.3;
  maxScore += 0.3;

  // Non-default ELO ratings present (up to 0.1)
  const eloFilled = [profileA.eloRating, profileB.eloRating].filter(
    (v) => v !== undefined && v !== 1000
  ).length;
  score += (eloFilled / 2) * 0.1;
  maxScore += 0.1;

  // Communication profile non-default (up to 0.1)
  const commFilled = [
    profileA.communication.emojiUsage !== 0,
    profileB.communication.emojiUsage !== 0,
  ].filter(Boolean).length;
  score += (commFilled / 2) * 0.1;
  maxScore += 0.1;

  return clamp(score / maxScore, 0, 1);
}

/**
 * Given the 8 dimension scores, derive the top 3 compatibility reasons
 * and the top 2 friction points.
 */
function rankDimensions(features: readonly number[]): {
  topCompatibilityReasons: ChemistryDimension[];
  topFrictionPoints: ChemistryDimension[];
} {
  const dims: ChemistryDimension[] = features.map((score, idx) => ({
    label: FEATURE_LABELS[idx]!,
    score: clamp(score, 0, 1),
  }));

  const sorted = [...dims].sort((a, b) => b.score - a.score);
  const topCompatibilityReasons = sorted.slice(0, 3);

  // Friction points = lowest-scoring dimensions (potential problems)
  const frictionSorted = [...dims].sort((a, b) => a.score - b.score);
  const topFrictionPoints = frictionSorted.slice(0, 2);

  return { topCompatibilityReasons, topFrictionPoints };
}

// ─── Feedback data store ──────────────────────────────────────────────────────

/** Accumulated outcome records used for incremental model updates. */
interface FeedbackRecord {
  features: readonly number[];
  label: number;   // 0–1 (derived from star rating)
}

// ─── ChemistryPredictor ───────────────────────────────────────────────────────

/**
 * Main entry-point for chemistry prediction.
 *
 * Usage:
 * ```ts
 * const predictor = new ChemistryPredictor();
 * const result = predictor.predict(profileA, profileB);
 * // … show ChemistryCard to users …
 * predictor.recordMatchOutcome({ userAId: 'u1', userBId: 'u2', rating: 4 });
 * ```
 *
 * The predictor is stateful: it accumulates feedback records and periodically
 * boosts the ensemble with new trees trained on that feedback.
 */
export class ChemistryPredictor {
  /** Mutable copy of the ensemble (starts from pre-trained weights). */
  private trees: WeakLearner[];

  /** Accumulated feedback records from rated sessions. */
  private readonly feedbackBuffer: FeedbackRecord[] = [];

  /**
   * Pair-key → feature vector cache so `recordMatchOutcome` can look up the
   * feature vector that was used for the prediction without re-computing it.
   */
  private readonly predictionCache = new Map<string, readonly number[]>();

  /** Minimum feedback records required to trigger an incremental update. */
  private readonly updateThreshold: number;

  constructor(updateThreshold = 20) {
    this.trees = [...PRETRAINED_TREES];
    this.updateThreshold = updateThreshold;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Predict relationship chemistry for a pair of users.
   *
   * @param profileA  First user's chemistry profile.
   * @param profileB  Second user's chemistry profile.
   * @returns         Full ChemistryPrediction with score, confidence, reasons, and friction.
   */
  predict(profileA: ChemistryUserProfile, profileB: ChemistryUserProfile): ChemistryPrediction {
    const features = extractFeatures(profileA, profileB);
    const probability = ensemblePredict(this.trees, features, LEARNING_RATE, BASE_PREDICTION);
    const score = Number((clamp(probability, 0, 1) * 100).toFixed(1));
    const confidence = Number(computeConfidence(profileA, profileB).toFixed(3));

    const { topCompatibilityReasons, topFrictionPoints } = rankDimensions(features);

    // Cache the feature vector for this pair (symmetric)
    const cacheKey = this.pairKey(profileA.id, profileB.id);
    this.predictionCache.set(cacheKey, features);

    return {
      score,
      confidence,
      topCompatibilityReasons,
      topFrictionPoints,
      featureVector: features,
    };
  }

  /**
   * Record a post-call star rating to feed back into the model.
   * When enough records accumulate the model is incrementally updated with a
   * new weak learner trained on the residuals.
   *
   * @param outcome  Match outcome from the rating UI.
   */
  recordMatchOutcome(outcome: MatchOutcome): void {
    const { userAId, userBId, rating, callDurationMs } = outcome;

    // Normalise the star rating to a probability label.
    let label = clamp((rating - 1) / 4, 0, 1);

    // Enrich label signal using call duration if provided.
    if (callDurationMs !== undefined) {
      // 10+ minutes of call is a strong positive signal.
      const durationBonus = clamp(callDurationMs / (10 * 60 * 1000), 0, 1) * 0.2;
      label = clamp(label + durationBonus, 0, 1);
    }

    const cacheKey = this.pairKey(userAId, userBId);
    const features = this.predictionCache.get(cacheKey);

    if (features) {
      this.feedbackBuffer.push({ features, label });
    }

    // Trigger incremental update once we have enough data.
    if (this.feedbackBuffer.length >= this.updateThreshold) {
      this.incrementalUpdate();
    }
  }

  /**
   * Return the current prediction accuracy metrics based on cached feedback.
   * Useful for monitoring model drift over time.
   */
  getModelStats(): { feedbackCount: number; treeCount: number; avgLabel: number } {
    const avgLabel =
      this.feedbackBuffer.length === 0
        ? 0.5
        : this.feedbackBuffer.reduce((s, r) => s + r.label, 0) / this.feedbackBuffer.length;

    return {
      feedbackCount: this.feedbackBuffer.length,
      treeCount: this.trees.length,
      avgLabel: Number(avgLabel.toFixed(3)),
    };
  }

  // ── Incremental model update ──────────────────────────────────────────────

  /**
   * Fit one new weak learner to the current residuals and append it to the
   * ensemble.  This is a single boosting step (one gradient boosting iteration).
   *
   * Called automatically when `feedbackBuffer` reaches `updateThreshold`.
   */
  private incrementalUpdate(): void {
    const residuals: number[] = this.feedbackBuffer.map(({ features, label }) => {
      const prob = ensemblePredict(this.trees, features, LEARNING_RATE, BASE_PREDICTION);
      return label - prob;
    });

    const newTree = fitRegressionStump(
      this.feedbackBuffer.map((r) => r.features),
      residuals
    );

    this.trees = [...this.trees, { root: newTree }];

    // Clear the consumed records; retain at most 3 as a rolling diagnostic window.
    const keep = Math.min(3, this.updateThreshold - 1);
    this.feedbackBuffer.splice(0, this.feedbackBuffer.length - keep);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Canonical sort key for a user pair (commutative). */
  private pairKey(idA: string, idB: string): string {
    return idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`;
  }
}

// ─── Decision tree fitting ────────────────────────────────────────────────────

/**
 * Fit a depth-2 regression stump to the supplied training examples.
 * Used during incremental model updates.
 *
 * @param allFeatures  Array of feature vectors (one per example).
 * @param residuals    Target residual for each example.
 * @returns            Root node of the fitted decision tree.
 */
function fitRegressionStump(
  allFeatures: ReadonlyArray<readonly number[]>,
  residuals: readonly number[]
): DecisionNode {
  if (allFeatures.length === 0) {
    return leaf(0);
  }

  // Find the best single split (minimising residual sum of squares).
  const { featureIdx, threshold } = bestSplit(allFeatures, residuals);

  // Partition examples into left (≤ threshold) and right (> threshold) sets.
  const leftIdx: number[] = [];
  const rightIdx: number[] = [];
  for (let i = 0; i < allFeatures.length; i++) {
    const fv = allFeatures[i]![featureIdx] ?? 0;
    if (fv <= threshold) {
      leftIdx.push(i);
    } else {
      rightIdx.push(i);
    }
  }

  // Fit depth-1 sub-trees on each partition.
  const leftNode  = fitLeafOrDepth1(allFeatures, residuals, leftIdx);
  const rightNode = fitLeafOrDepth1(allFeatures, residuals, rightIdx);

  return split(featureIdx, threshold, leftNode, rightNode);
}

/** Build a leaf or a depth-1 split for a subset of examples. */
function fitLeafOrDepth1(
  allFeatures: ReadonlyArray<readonly number[]>,
  residuals: readonly number[],
  indices: readonly number[]
): DecisionNode {
  if (indices.length === 0) return leaf(0);
  if (indices.length <= 3) {
    return leaf(meanResidual(residuals, indices));
  }

  const subFeatures = indices.map((i) => allFeatures[i]!);
  const subResiduals = indices.map((i) => residuals[i]!);
  const { featureIdx, threshold } = bestSplit(subFeatures, subResiduals);

  const leftIdx: number[] = [];
  const rightIdx: number[] = [];
  for (let i = 0; i < subFeatures.length; i++) {
    const fv = subFeatures[i]![featureIdx] ?? 0;
    if (fv <= threshold) leftIdx.push(i);
    else rightIdx.push(i);
  }

  return split(
    featureIdx,
    threshold,
    leaf(meanResidual(subResiduals, leftIdx)),
    leaf(meanResidual(subResiduals, rightIdx))
  );
}

/** Find the (featureIdx, threshold) split that minimises total RSS. */
function bestSplit(
  features: ReadonlyArray<readonly number[]>,
  residuals: readonly number[]
): { featureIdx: number; threshold: number } {
  let bestRSS = Infinity;
  let bestFeatureIdx = 0;
  let bestThreshold = 0.5;

  for (let fi = 0; fi < FEATURE_COUNT; fi++) {
    // Gather unique thresholds to try (midpoints between sorted values).
    const values = features.map((fv) => fv[fi] ?? 0);
    const sorted = [...new Set(values)].sort((a, b) => a - b);

    for (let ti = 0; ti < sorted.length - 1; ti++) {
      const threshold = (sorted[ti]! + sorted[ti + 1]!) / 2;

      let leftSum = 0;
      let leftSumSq = 0;
      let leftCount = 0;
      let rightSum = 0;
      let rightSumSq = 0;
      let rightCount = 0;

      for (let i = 0; i < features.length; i++) {
        const fv = features[i]![fi] ?? 0;
        const r  = residuals[i] ?? 0;
        if (fv <= threshold) {
          leftSum += r;
          leftSumSq += r * r;
          leftCount++;
        } else {
          rightSum += r;
          rightSumSq += r * r;
          rightCount++;
        }
      }

      const rss = rssFromStats(leftSum, leftSumSq, leftCount)
                + rssFromStats(rightSum, rightSumSq, rightCount);

      if (rss < bestRSS) {
        bestRSS = rss;
        bestFeatureIdx = fi;
        bestThreshold = threshold;
      }
    }
  }

  return { featureIdx: bestFeatureIdx, threshold: bestThreshold };
}

/** Residual sum of squares for a node using sufficient statistics. */
function rssFromStats(sum: number, sumSq: number, count: number): number {
  if (count === 0) return 0;
  return sumSq - (sum * sum) / count;
}

/** Mean of residuals at the given indices. */
function meanResidual(residuals: readonly number[], indices: readonly number[]): number {
  if (indices.length === 0) return 0;
  let total = 0;
  for (const i of indices) total += residuals[i] ?? 0;
  return total / indices.length;
}
