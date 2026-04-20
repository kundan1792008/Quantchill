import test from 'node:test';
import assert from 'node:assert/strict';
import { HologramViewer } from '../src/components/HologramViewer';

test('HologramViewer clamps extreme gyroscope readings into camera orbit bounds', () => {
  const viewer = new HologramViewer();
  const orbit = viewer.applyGyroscope({
    alpha: 190,
    beta: -85,
    gamma: 120,
    timestampMs: 123
  });

  assert.equal(orbit.rollDeg, 180);
  assert.equal(orbit.pitchDeg, -80);
  assert.equal(orbit.yawDeg, 90);
  assert.equal(orbit.updatedAtMs, 123);
});

test('HologramViewer preserves in-range gyroscope values without clamping drift', () => {
  const viewer = new HologramViewer();
  const orbit = viewer.applyGyroscope({
    alpha: 45,
    beta: -30,
    gamma: 25,
    timestampMs: 456
  });

  assert.equal(orbit.rollDeg, 45);
  assert.equal(orbit.pitchDeg, -30);
  assert.equal(orbit.yawDeg, 25);
  assert.equal(orbit.updatedAtMs, 456);
});

test('HologramViewer transitions instantly when engagement drops below threshold', () => {
  const viewer = new HologramViewer(40);

  assert.equal(viewer.updateEngagement(70), false);
  assert.equal(viewer.updateEngagement(39), true);
  assert.equal(viewer.getState().shouldTransitionLoop, true);
});

test('HologramViewer touch resolves closest spatial audio snippet in range', () => {
  const viewer = new HologramViewer();
  viewer.setSpatialAudioSnippets([
    {
      id: 'voice-left',
      src: '/audio/left.mp3',
      anchor: { x: -0.5, y: 0, z: 0 },
      activationRadius: 0.8,
      gain: 0.8
    },
    {
      id: 'voice-right',
      src: '/audio/right.mp3',
      anchor: { x: 0.7, y: 0, z: 0 },
      activationRadius: 0.4,
      gain: 0.7
    }
  ]);

  const selected = viewer.touch({ x: 0.2, y: 0.5 });
  assert.equal(selected?.id, 'voice-left');
  assert.equal(viewer.getState().activeSnippetId, 'voice-left');
});

test('HologramViewer touch returns null when no snippet is in radius', () => {
  const viewer = new HologramViewer();
  viewer.setSpatialAudioSnippets([
    {
      id: 'far',
      src: '/audio/far.mp3',
      anchor: { x: 1, y: 1, z: 1 },
      activationRadius: 0.1,
      gain: 0.5
    }
  ]);

  const selected = viewer.touch({ x: 0.5, y: 0.5 });
  assert.equal(selected, null);
  assert.equal(viewer.getState().activeSnippetId, null);
});
