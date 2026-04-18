import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChemistryPredictor,
  ChemistryUserProfile,
  CompatibilityLabel,
} from '../src/services/ChemistryPredictor';
import { CompatibilityExplainer } from '../src/services/CompatibilityExplainer';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<ChemistryUserProfile> = {}): ChemistryUserProfile {
  return {
    id: 'u1',
    interests: { music: 80, travel: 70, tech: 60 },
    communication: {
      avgResponseTimeMs: 120_000,
      messageLength: 'medium',
      emojiUsage: 0.5,
      formality: 0.3,
    },
    activityHours: [20, 21, 22, 23],
    humorScore: 70,
    eloRating: 1200,
    conversationDepth: 0.7,
    empathyScore: 0.75,
    ...overrides,
  };
}

/** A second profile, highly compatible with the default one. */
const profileA = makeProfile({ id: 'u1' });
const profileB = makeProfile({
  id: 'u2',
  interests: { music: 90, travel: 65, tech: 55 },
  communication: {
    avgResponseTimeMs: 90_000,
    messageLength: 'medium',
    emojiUsage: 0.55,
    formality: 0.35,
  },
});

/** A profile that is highly INcompatible with profileA. */
const profileC = makeProfile({
  id: 'u3',
  interests: { cooking: 90, knitting: 80 },
  communication: {
    avgResponseTimeMs: 3_600_000, // 1-hour response time
    messageLength: 'brief',
    emojiUsage: 0.0,
    formality: 0.9,
  },
  activityHours: [6, 7, 8],
  humorScore: 20,
  eloRating: 600,
  conversationDepth: 0.1,
  empathyScore: 0.2,
});

// ─── ChemistryPredictor tests ─────────────────────────────────────────────────

test('ChemistryPredictor: score is in range [0, 100]', () => {
  const predictor = new ChemistryPredictor();
  const result = predictor.predict(profileA, profileB);
  assert.ok(result.score >= 0, `score should be >= 0, got ${result.score}`);
  assert.ok(result.score <= 100, `score should be <= 100, got ${result.score}`);
});

test('ChemistryPredictor: highly compatible pair scores higher than incompatible pair', () => {
  const predictor = new ChemistryPredictor();
  const highScore = predictor.predict(profileA, profileB);
  const lowScore  = predictor.predict(profileA, profileC);
  assert.ok(
    highScore.score > lowScore.score,
    `compatible pair (${highScore.score}) should score higher than incompatible pair (${lowScore.score})`
  );
});

test('ChemistryPredictor: confidence is in range [0, 1]', () => {
  const predictor = new ChemistryPredictor();
  const result = predictor.predict(profileA, profileB);
  assert.ok(result.confidence >= 0, 'confidence must be >= 0');
  assert.ok(result.confidence <= 1, 'confidence must be <= 1');
});

test('ChemistryPredictor: richer profiles yield higher confidence', () => {
  const predictor = new ChemistryPredictor();

  const rich = predictor.predict(profileA, profileB);

  const sparseA = makeProfile({
    id: 'sA',
    interests: {},
    activityHours: [],
    conversationDepth: undefined,
    empathyScore: undefined,
    eloRating: undefined,
  });
  const sparseB = makeProfile({
    id: 'sB',
    interests: {},
    activityHours: [],
    conversationDepth: undefined,
    empathyScore: undefined,
    eloRating: undefined,
  });
  const sparse = predictor.predict(sparseA, sparseB);

  assert.ok(
    rich.confidence > sparse.confidence,
    `rich confidence (${rich.confidence}) should exceed sparse confidence (${sparse.confidence})`
  );
});

test('ChemistryPredictor: returns exactly 3 compatibility reasons', () => {
  const predictor = new ChemistryPredictor();
  const result = predictor.predict(profileA, profileB);
  assert.equal(result.topCompatibilityReasons.length, 3);
});

test('ChemistryPredictor: returns exactly 2 friction points', () => {
  const predictor = new ChemistryPredictor();
  const result = predictor.predict(profileA, profileB);
  assert.equal(result.topFrictionPoints.length, 2);
});

test('ChemistryPredictor: compatibility reason scores are in [0, 1]', () => {
  const predictor = new ChemistryPredictor();
  const { topCompatibilityReasons } = predictor.predict(profileA, profileB);
  for (const reason of topCompatibilityReasons) {
    assert.ok(reason.score >= 0 && reason.score <= 1, `reason score ${reason.score} out of range`);
  }
});

test('ChemistryPredictor: friction point scores are in [0, 1]', () => {
  const predictor = new ChemistryPredictor();
  const { topFrictionPoints } = predictor.predict(profileA, profileB);
  for (const fp of topFrictionPoints) {
    assert.ok(fp.score >= 0 && fp.score <= 1, `friction score ${fp.score} out of range`);
  }
});

test('ChemistryPredictor: top reasons have higher scores than top friction points (for compatible pair)', () => {
  const predictor = new ChemistryPredictor();
  const { topCompatibilityReasons, topFrictionPoints } = predictor.predict(profileA, profileB);
  const minReason  = Math.min(...topCompatibilityReasons.map((r) => r.score));
  const maxFriction = Math.max(...topFrictionPoints.map((f) => f.score));
  assert.ok(
    minReason >= maxFriction,
    `min reason score (${minReason}) should be >= max friction score (${maxFriction})`
  );
});

test('ChemistryPredictor: feature vector has 8 elements in [0, 1]', () => {
  const predictor = new ChemistryPredictor();
  const { featureVector } = predictor.predict(profileA, profileB);
  assert.equal(featureVector.length, 8);
  for (const v of featureVector) {
    assert.ok(v >= 0 && v <= 1, `feature value ${v} out of [0, 1]`);
  }
});

test('ChemistryPredictor: prediction is symmetric (A,B) == (B,A)', () => {
  const predictor = new ChemistryPredictor();
  const ab = predictor.predict(profileA, profileB);
  const ba = predictor.predict(profileB, profileA);
  assert.equal(ab.score, ba.score, 'score should be symmetric');
  assert.equal(ab.confidence, ba.confidence, 'confidence should be symmetric');
});

test('ChemistryPredictor: all dimension labels are valid CompatibilityLabels', () => {
  const validLabels: Set<CompatibilityLabel> = new Set([
    'shared_interests',
    'communication_style',
    'activity_timing',
    'response_speed',
    'humor_alignment',
    'elo_proximity',
    'conversation_depth',
    'empathy_match',
  ]);

  const predictor = new ChemistryPredictor();
  const { topCompatibilityReasons, topFrictionPoints } = predictor.predict(profileA, profileC);

  for (const dim of [...topCompatibilityReasons, ...topFrictionPoints]) {
    assert.ok(validLabels.has(dim.label), `unknown label: ${dim.label}`);
  }
});

test('ChemistryPredictor: getModelStats returns sane defaults', () => {
  const predictor = new ChemistryPredictor();
  const stats = predictor.getModelStats();
  assert.equal(stats.feedbackCount, 0);
  assert.ok(stats.treeCount >= 20, 'should start with at least 20 pre-trained trees');
  assert.equal(stats.avgLabel, 0.5);
});

test('ChemistryPredictor: recordMatchOutcome increments feedback buffer', () => {
  const predictor = new ChemistryPredictor();

  // Predict first so the feature vector is cached.
  predictor.predict(profileA, profileB);

  predictor.recordMatchOutcome({ userAId: 'u1', userBId: 'u2', rating: 5 });

  const stats = predictor.getModelStats();
  assert.ok(stats.feedbackCount >= 1, 'feedback count should be at least 1 after one outcome');
});

test('ChemistryPredictor: recordMatchOutcome without prior prediction is a no-op', () => {
  const predictor = new ChemistryPredictor();

  // No prior predict call — cache will be empty.
  predictor.recordMatchOutcome({ userAId: 'u99', userBId: 'u100', rating: 3 });

  const stats = predictor.getModelStats();
  assert.equal(stats.feedbackCount, 0, 'should not add to buffer when no features are cached');
});

test('ChemistryPredictor: incremental update triggers at threshold', () => {
  const THRESHOLD = 5;
  const predictor = new ChemistryPredictor(THRESHOLD);

  // Predict several unique pairs so feature vectors are cached.
  for (let i = 0; i < THRESHOLD; i++) {
    const pA = makeProfile({ id: `a${i}` });
    const pB = makeProfile({ id: `b${i}` });
    predictor.predict(pA, pB);
    predictor.recordMatchOutcome({ userAId: `a${i}`, userBId: `b${i}`, rating: 4 });
  }

  const stats = predictor.getModelStats();
  // After hitting the threshold the buffer should be cleared (≤ THRESHOLD - 1 items left).
  assert.ok(
    stats.feedbackCount < THRESHOLD,
    `buffer should have been flushed, got ${stats.feedbackCount}`
  );
  // A new tree should have been appended to the ensemble.
  assert.ok(stats.treeCount > 20, `tree count should grow after update, got ${stats.treeCount}`);
});

test('ChemistryPredictor: call duration bonus enriches label', () => {
  const predictor = new ChemistryPredictor(2);

  const pA = makeProfile({ id: 'x1' });
  const pB = makeProfile({ id: 'x2' });
  predictor.predict(pA, pB);

  // A 10-minute call with a 3-star base rating → label > 0.5
  predictor.recordMatchOutcome({
    userAId: 'x1',
    userBId: 'x2',
    rating: 3,
    callDurationMs: 10 * 60 * 1000,
  });

  const pA2 = makeProfile({ id: 'x3' });
  const pB2 = makeProfile({ id: 'x4' });
  predictor.predict(pA2, pB2);
  predictor.recordMatchOutcome({
    userAId: 'x3',
    userBId: 'x4',
    rating: 3,
    callDurationMs: 10 * 60 * 1000,
  });

  const stats = predictor.getModelStats();
  // avgLabel should be above the neutral 0.5 because of the duration bonus on top of the 3-star rating
  assert.ok(stats.avgLabel > 0.5, `expected avgLabel > 0.5 with duration bonus, got ${stats.avgLabel}`);
});

// ─── CompatibilityExplainer tests ─────────────────────────────────────────────

test('CompatibilityExplainer: returns non-empty headline', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileB);
  const explanation = explainer.explain(profileA, profileB, prediction);
  assert.ok(explanation.headline.length > 0, 'headline should not be empty');
});

test('CompatibilityExplainer: returns 3 compatibility reasons', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileB);
  const explanation = explainer.explain(profileA, profileB, prediction);
  assert.equal(explanation.compatibilityReasons.length, 3);
});

test('CompatibilityExplainer: friction warnings non-empty for incompatible pair', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileC);
  const explanation = explainer.explain(profileA, profileC, prediction);
  assert.ok(
    explanation.frictionWarnings.length > 0,
    'should have friction warnings for an incompatible pair'
  );
});

test('CompatibilityExplainer: hasPotentialDealBreaker is true for very incompatible pair', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileC);
  const explanation = explainer.explain(profileA, profileC, prediction);
  assert.ok(
    explanation.hasPotentialDealBreaker,
    'should flag deal-breaker for highly incompatible pair'
  );
});

test('CompatibilityExplainer: hasPotentialDealBreaker is false for highly compatible pair', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileB);
  const explanation = explainer.explain(profileA, profileB, prediction);
  assert.equal(
    explanation.hasPotentialDealBreaker,
    false,
    'should not flag deal-breaker for highly compatible pair'
  );
});

test('CompatibilityExplainer: conversation starters provided for profile with interests', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileB);
  const explanation = explainer.explain(profileA, profileB, prediction);
  assert.ok(
    explanation.conversationStarters.length >= 3,
    `expected at least 3 starters, got ${explanation.conversationStarters.length}`
  );
});

test('CompatibilityExplainer: up to 5 conversation starters returned', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileB);
  const explanation = explainer.explain(profileA, profileB, prediction);
  assert.ok(
    explanation.conversationStarters.length <= 5,
    `should return at most 5 starters, got ${explanation.conversationStarters.length}`
  );
});

test('CompatibilityExplainer: summary is a non-empty string', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileB);
  const explanation = explainer.explain(profileA, profileB, prediction);
  assert.ok(typeof explanation.summary === 'string' && explanation.summary.length > 0);
});

test('CompatibilityExplainer: shortReason returns non-empty string', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileB);
  const reason = prediction.topCompatibilityReasons[0]!;
  const short = explainer.shortReason(reason);
  assert.ok(short.length > 0, 'shortReason should return a non-empty string');
});

test('CompatibilityExplainer: shortWarning returns non-empty string', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();
  const prediction = predictor.predict(profileA, profileC);
  const friction = prediction.topFrictionPoints[0]!;
  const warning = explainer.shortWarning(friction);
  assert.ok(warning.length > 0, 'shortWarning should return a non-empty string');
  assert.ok(warning.startsWith('⚠️'), 'warning should start with the warning emoji');
});

test('CompatibilityExplainer: conversation starters differ for different shared interest sets', () => {
  const predictor = new ChemistryPredictor();
  const explainer = new CompatibilityExplainer();

  const techProfileA = makeProfile({ id: 'ta', interests: { tech: 90, coding: 80 } });
  const techProfileB = makeProfile({ id: 'tb', interests: { tech: 85, coding: 75 } });

  const musicProfileA = makeProfile({ id: 'ma', interests: { music: 90, guitar: 80 } });
  const musicProfileB = makeProfile({ id: 'mb', interests: { music: 85, vinyl: 70 } });

  const techPred  = predictor.predict(techProfileA, techProfileB);
  const musicPred = predictor.predict(musicProfileA, musicProfileB);

  const techExpl  = explainer.explain(techProfileA, techProfileB, techPred);
  const musicExpl = explainer.explain(musicProfileA, musicProfileB, musicPred);

  // The starter lists should differ because the interest sets differ.
  const techSet  = new Set(techExpl.conversationStarters);
  const musicSet = new Set(musicExpl.conversationStarters);
  const intersection = [...techSet].filter((s) => musicSet.has(s));

  assert.ok(
    intersection.length < techSet.size,
    'different interest sets should produce different conversation starters'
  );
});
