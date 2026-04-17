import test from 'node:test';
import assert from 'node:assert/strict';
import { GemmaEngine } from '../src/ai_core/gemma_engine';
import type { MicroInteractionSignals, PredictionInput } from '../src/ai_core/gemma_engine';

const engine = new GemmaEngine();

// ─── Signal normalisation ─────────────────────────────────────────────────────

test('GemmaEngine: high engagement signals produce probability > 0.5', () => {
  const signals: MicroInteractionSignals = {
    timeOnCardMs: 8000,   // long dwell
    scrollSpeedPx: 50,    // slow scroll
    revisitCount: 3,
    pauseCount: 5
  };
  const result = engine.predict({ signals });
  assert.ok(result.matchSuccessProbability > 0.5, `expected > 0.5, got ${result.matchSuccessProbability}`);
});

test('GemmaEngine: low engagement signals produce probability < 0.5', () => {
  const signals: MicroInteractionSignals = {
    timeOnCardMs: 200,    // fleeting glance
    scrollSpeedPx: 700,   // fast scroll
    revisitCount: 0,
    pauseCount: 0
  };
  const result = engine.predict({ signals });
  assert.ok(result.matchSuccessProbability < 0.5, `expected < 0.5, got ${result.matchSuccessProbability}`);
});

test('GemmaEngine: matchSuccessProbability is within [0, 1]', () => {
  const extremes: MicroInteractionSignals[] = [
    { timeOnCardMs: 0, scrollSpeedPx: 10_000, revisitCount: 0, pauseCount: 0 },
    { timeOnCardMs: 60_000, scrollSpeedPx: 0, revisitCount: 100, pauseCount: 100 }
  ];
  for (const signals of extremes) {
    const { matchSuccessProbability } = engine.predict({ signals });
    assert.ok(matchSuccessProbability >= 0, 'probability must be ≥ 0');
    assert.ok(matchSuccessProbability <= 1, 'probability must be ≤ 1');
  }
});

// ─── ELO adjustment ──────────────────────────────────────────────────────────

test('GemmaEngine: strong engagement produces positive ELO adjustment', () => {
  const signals: MicroInteractionSignals = {
    timeOnCardMs: 9000,
    scrollSpeedPx: 10,
    revisitCount: 4,
    pauseCount: 8
  };
  const result = engine.predict({ signals, viewerElo: 1000, subjectElo: 1000, kFactor: 20 });
  assert.ok(result.eloAdjustment > 0, `expected positive delta, got ${result.eloAdjustment}`);
});

test('GemmaEngine: weak engagement produces non-positive ELO adjustment', () => {
  const signals: MicroInteractionSignals = {
    timeOnCardMs: 100,
    scrollSpeedPx: 750,
    revisitCount: 0,
    pauseCount: 0
  };
  const result = engine.predict({ signals, viewerElo: 1000, subjectElo: 1000, kFactor: 20 });
  assert.ok(result.eloAdjustment <= 0, `expected ≤ 0, got ${result.eloAdjustment}`);
});

test('GemmaEngine: ELO adjustment uses kFactor correctly', () => {
  const signals: MicroInteractionSignals = {
    timeOnCardMs: 8000,
    scrollSpeedPx: 100,
    revisitCount: 2,
    pauseCount: 4
  };
  const r10 = engine.predict({ signals, viewerElo: 1000, subjectElo: 1000, kFactor: 10 });
  const r40 = engine.predict({ signals, viewerElo: 1000, subjectElo: 1000, kFactor: 40 });
  assert.ok(
    Math.abs(r40.eloAdjustment) >= Math.abs(r10.eloAdjustment),
    'higher kFactor should yield larger |eloAdjustment|'
  );
});

// ─── Confidence ───────────────────────────────────────────────────────────────

test('GemmaEngine: confidence is within [0, 1]', () => {
  const signals: MicroInteractionSignals = {
    timeOnCardMs: 5000,
    scrollSpeedPx: 200,
    revisitCount: 1,
    pauseCount: 3
  };
  const { confidence } = engine.predict({ signals });
  assert.ok(confidence >= 0 && confidence <= 1, `confidence out of range: ${confidence}`);
});

test('GemmaEngine: more data increases confidence', () => {
  const sparse: MicroInteractionSignals = {
    timeOnCardMs: 0, scrollSpeedPx: 800, revisitCount: 0, pauseCount: 0
  };
  const rich: MicroInteractionSignals = {
    timeOnCardMs: 6000, scrollSpeedPx: 50, revisitCount: 3, pauseCount: 5
  };
  const sparseResult = engine.predict({ signals: sparse });
  const richResult = engine.predict({ signals: rich });
  assert.ok(richResult.confidence > sparseResult.confidence, 'richer signals should give higher confidence');
});

// ─── Default ELO values ───────────────────────────────────────────────────────

test('GemmaEngine: defaults viewerElo and subjectElo to 1000 when omitted', () => {
  const signals: MicroInteractionSignals = {
    timeOnCardMs: 5000, scrollSpeedPx: 200, revisitCount: 1, pauseCount: 3
  };
  const withDefaults = engine.predict({ signals });
  const explicit = engine.predict({ signals, viewerElo: 1000, subjectElo: 1000 });
  assert.equal(withDefaults.eloAdjustment, explicit.eloAdjustment);
  assert.equal(withDefaults.matchSuccessProbability, explicit.matchSuccessProbability);
});

// ─── ELO-context influence ────────────────────────────────────────────────────

test('GemmaEngine: lower-rated viewer vs higher-rated subject gets larger positive adjustment', () => {
  const signals: MicroInteractionSignals = {
    timeOnCardMs: 9000, scrollSpeedPx: 10, revisitCount: 4, pauseCount: 8
  };
  const balanced = engine.predict({ signals, viewerElo: 1000, subjectElo: 1000, kFactor: 20 });
  const underdog = engine.predict({ signals, viewerElo: 800, subjectElo: 1200, kFactor: 20 });
  // underdog's expected score is lower → larger positive delta for the same actual outcome
  assert.ok(underdog.eloAdjustment >= balanced.eloAdjustment);
});
