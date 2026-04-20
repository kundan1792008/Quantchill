import test from 'node:test';
import assert from 'node:assert/strict';
import { HologramSynth, ProfileVideoFrame } from '../src/services/HologramSynth';

function makeFrame(width: number, height: number, value: number, timestampMs: number): ProfileVideoFrame {
  return {
    width,
    height,
    timestampMs,
    luma: Array.from({ length: width * height }, () => value)
  };
}

test('HologramSynth extracts normalized depth maps from uploaded frames', () => {
  const synth = new HologramSynth();
  const frames = [makeFrame(4, 4, 255, 0), makeFrame(4, 4, 64, 16)];
  const maps = synth.extractDepthMaps(frames);

  assert.equal(maps.length, 2);
  assert.equal(maps[0]?.depth.length, 16);
  const firstDepth = maps[0]?.depth[0] ?? 0;
  const secondDepth = maps[1]?.depth[0] ?? 0;
  // Frame 1 uses temporalGradient=0, so depth is 1 - (1.0*0.8 + 0*0.2) = 0.2.
  const normalizedLuma = 64 / 255;
  const temporalGradient = Math.abs(64 - 255) / 255;
  const expectedSecondDepth = 1 - (normalizedLuma * 0.8 + temporalGradient * 0.2);
  assert.ok(Math.abs(firstDepth - 0.2) < 1e-9);
  assert.ok(Math.abs(secondDepth - expectedSecondDepth) < 1e-9);
});

test('HologramSynth constructs point cloud and bounds from depth maps', () => {
  const synth = new HologramSynth({ pointStride: 2, depthScale: 2 });
  const maps = synth.extractDepthMaps([makeFrame(4, 4, 128, 0)]);
  const cloud = synth.constructPointCloud(maps);

  assert.ok(cloud.points.length > 0);
  assert.ok(cloud.bounds.maxZ >= cloud.bounds.minZ);
  assert.ok(cloud.points.every((p) => p.z >= 0 && p.z <= 2));
});

test('HologramSynth provides holographic shader program source and uniforms', () => {
  const synth = new HologramSynth();
  const shader = synth.buildHologramShader();

  assert.ok(shader.vertexShader.includes('uPulseStrength'));
  assert.ok(shader.fragmentShader.includes('uScanlineMix'));
  assert.equal(shader.uniforms.uGlow, 0.5);
});

test('HologramSynth synthesizes upload into depth maps, point cloud, and shader', () => {
  const synth = new HologramSynth({ pointStride: 1 });
  const result = synth.synthesize({
    userId: 'user-holo',
    frames: [makeFrame(3, 3, 170, 0)]
  });

  assert.equal(result.userId, 'user-holo');
  assert.equal(result.depthMaps.length, 1);
  assert.ok(result.pointCloud.points.length >= 9);
  assert.ok(result.shader.vertexShader.length > 20);
});
