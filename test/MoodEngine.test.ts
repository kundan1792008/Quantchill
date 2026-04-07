import test from 'node:test';
import assert from 'node:assert/strict';
import { MoodEngine, MoodName } from '../src/services/MoodEngine';

test('MoodEngine lists all four moods', () => {
  const engine = new MoodEngine();
  const moods = engine.listMoods();
  const names = moods.map((m) => m.name);

  assert.ok(names.includes('Deep Focus'));
  assert.ok(names.includes('Cyberpunk Rain'));
  assert.ok(names.includes('Ethereal Sleep'));
  assert.ok(names.includes('Hype Workout'));
  assert.equal(moods.length, 4);
});

test('MoodEngine selectMood updates current mood and resets variation', () => {
  const engine = new MoodEngine('Deep Focus');

  // Evolve once so variation counter is non-zero
  engine.evolveTrack();
  const afterEvolve = engine.generateTrack();
  assert.ok(afterEvolve.variation > 0);

  // Switching mood should reset counter
  engine.selectMood('Hype Workout');
  assert.equal(engine.getCurrentMood(), 'Hype Workout');
  const fresh = engine.generateTrack();
  assert.equal(fresh.variation, 0);
});

test('MoodEngine generateTrack returns correct mood metadata', () => {
  const engine = new MoodEngine('Cyberpunk Rain');
  const track = engine.generateTrack('Cyberpunk Rain');

  assert.equal(track.mood, 'Cyberpunk Rain');
  assert.equal(track.key, 'D');
  assert.equal(track.scale, 'minor');
  assert.ok(track.bpm > 0);
  assert.ok(track.intensity >= 0 && track.intensity <= 1);
});

test('MoodEngine evolveTrack increments variation counter', () => {
  const engine = new MoodEngine('Deep Focus');

  const t0 = engine.generateTrack();
  assert.equal(t0.variation, 0);

  const t1 = engine.evolveTrack();
  assert.equal(t1.variation, 1);

  const t2 = engine.evolveTrack();
  assert.equal(t2.variation, 2);
});

test('MoodEngine evaluateBCIContext triggers transition when engagement is low', () => {
  const engine = new MoodEngine('Deep Focus', 40);

  const event = engine.evaluateBCIContext({ eyeTrackingFocus: 60, engagementScore: 30 });
  assert.ok(event !== null);
  assert.equal(event!.previousMood, 'Deep Focus');
  assert.equal(event!.reason, 'bci-low-engagement');
  assert.equal(event!.engagementScore, 30);
  // After transition the engine's mood should have changed
  assert.notEqual(engine.getCurrentMood(), 'Deep Focus');
});

test('MoodEngine evaluateBCIContext does NOT transition when engagement is sufficient', () => {
  const engine = new MoodEngine('Cyberpunk Rain', 40);

  const event = engine.evaluateBCIContext({ eyeTrackingFocus: 80, engagementScore: 75 });
  assert.equal(event, null);
  assert.equal(engine.getCurrentMood(), 'Cyberpunk Rain');
});

test('MoodEngine auto-transitions to the most contrasting mood on low engagement', () => {
  // Hype Workout (140 bpm) should contrast most against Ethereal Sleep (55 bpm)
  const engine = new MoodEngine('Ethereal Sleep', 40);
  engine.evaluateBCIContext({ eyeTrackingFocus: 50, engagementScore: 20 });
  assert.equal(engine.getCurrentMood(), 'Hype Workout');
});
