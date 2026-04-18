import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProfileVideoGenerator,
  PhotoAsset,
  MAX_PHOTOS,
  VIDEO_DURATION_S,
  VIDEO_WIDTH_PX,
  VIDEO_HEIGHT_PX,
  CLIP_DURATION_S,
} from '../src/services/ProfileVideoGenerator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePhoto(
  id: string,
  overrides: Partial<PhotoAsset> = {},
): PhotoAsset {
  return {
    id,
    url: `https://cdn.example.com/photos/${id}.jpg`,
    signals: {
      faceClarity: 70,
      lightingQuality: 65,
      backgroundAesthetics: 60,
      expressionDiversity: 55,
    },
    ...overrides,
  };
}

function makePhotos(count: number): PhotoAsset[] {
  return Array.from({ length: count }, (_, i) =>
    makePhoto(`photo-${i}`, {
      signals: {
        faceClarity: 50 + i * 3,
        lightingQuality: 55 + i * 2,
        backgroundAesthetics: 40 + i * 4,
        expressionDiversity: 60,
      },
    }),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('ProfileVideoGenerator: generate returns a valid VideoProfile', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(6);
  const profile = gen.generate('user-1', photos, { seed: 42 });

  assert.equal(profile.userId, 'user-1');
  assert.ok(profile.id.startsWith('vp-user-1-'));
  assert.equal(profile.totalDurationS, VIDEO_DURATION_S);
  assert.equal(profile.resolution.width, VIDEO_WIDTH_PX);
  assert.equal(profile.resolution.height, VIDEO_HEIGHT_PX);
  assert.ok(profile.clips.length > 0);
  assert.ok(profile.clips.length <= MAX_PHOTOS);
  assert.ok(typeof profile.generatedAt === 'string');
});

test('ProfileVideoGenerator: selects at most MAX_PHOTOS clips', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(10);
  const profile = gen.generate('user-2', photos, { seed: 1 });

  assert.ok(profile.clips.length <= MAX_PHOTOS);
});

test('ProfileVideoGenerator: handles exactly MAX_PHOTOS photos', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(MAX_PHOTOS);
  const profile = gen.generate('user-3', photos, { seed: 2 });

  assert.equal(profile.clips.length, MAX_PHOTOS);
});

test('ProfileVideoGenerator: handles fewer than MAX_PHOTOS photos', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(3);
  const profile = gen.generate('user-4', photos, { seed: 3 });

  assert.equal(profile.clips.length, 3);
});

test('ProfileVideoGenerator: handles empty photo array', () => {
  const gen = new ProfileVideoGenerator();
  const profile = gen.generate('user-5', [], { seed: 4 });

  assert.equal(profile.clips.length, 0);
  assert.equal(profile.totalDurationS, VIDEO_DURATION_S);
});

test('ProfileVideoGenerator: each clip has correct durationS', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(5);
  const profile = gen.generate('user-6', photos, { seed: 5 });

  for (const clip of profile.clips) {
    assert.equal(clip.durationS, CLIP_DURATION_S);
  }
});

test('ProfileVideoGenerator: last clip has no transitionOut', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(4);
  const profile = gen.generate('user-7', photos, { seed: 6 });

  const last = profile.clips[profile.clips.length - 1];
  assert.equal(last?.transitionOut, undefined);
});

test('ProfileVideoGenerator: non-last clips have a transitionOut', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(4);
  const profile = gen.generate('user-8', photos, { seed: 7 });

  const nonLast = profile.clips.slice(0, -1);
  for (const clip of nonLast) {
    assert.ok(clip.transitionOut !== undefined);
  }
});

test('ProfileVideoGenerator: music genre chill selected by default', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(3);
  const profile = gen.generate('user-9', photos, { seed: 8 });

  assert.equal(profile.music.genre, 'chill');
});

test('ProfileVideoGenerator: music genre override is respected', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(3);
  const profile = gen.generate('user-10', photos, {
    seed: 9,
    musicGenre: 'pop',
  });

  assert.equal(profile.music.genre, 'pop');
});

test('ProfileVideoGenerator: Ken Burns keyframes have scale >= 1.0', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(5);
  const profile = gen.generate('user-11', photos, { seed: 10 });

  for (const clip of profile.clips) {
    assert.ok(clip.kenBurns.from.scale >= 1.0, `from.scale should be >= 1.0`);
    assert.ok(clip.kenBurns.to.scale >= 1.0, `to.scale should be >= 1.0`);
  }
});

test('ProfileVideoGenerator: scorePhoto returns score in [0, 100]', () => {
  const gen = new ProfileVideoGenerator();

  const highQuality = makePhoto('hq', {
    signals: {
      faceClarity: 100,
      lightingQuality: 100,
      backgroundAesthetics: 100,
      expressionDiversity: 100,
    },
  });
  const lowQuality = makePhoto('lq', {
    signals: {
      faceClarity: 0,
      lightingQuality: 0,
      backgroundAesthetics: 0,
      expressionDiversity: 0,
    },
  });

  const hqScored = gen.scorePhoto(highQuality);
  const lqScored = gen.scorePhoto(lowQuality);

  assert.equal(hqScored.score, 100);
  assert.equal(lqScored.score, 0);
});

test('ProfileVideoGenerator: selectTopPhotos prefers higher-scored photos', () => {
  const gen = new ProfileVideoGenerator();

  const highPhoto = makePhoto('high', {
    signals: {
      faceClarity: 95,
      lightingQuality: 90,
      backgroundAesthetics: 85,
      expressionDiversity: 80,
    },
  });
  const lowPhoto = makePhoto('low', {
    signals: {
      faceClarity: 10,
      lightingQuality: 10,
      backgroundAesthetics: 10,
      expressionDiversity: 10,
    },
  });

  const selected = gen.selectTopPhotos([lowPhoto, highPhoto]);
  assert.ok(selected.length > 0);
  assert.equal(selected[0]!.photo.id, 'high');
});

test('ProfileVideoGenerator: Ken Burns focal point uses face bounding box', () => {
  const gen = new ProfileVideoGenerator();
  const prng = () => 0.5; // deterministic

  const photo = makePhoto('face-test', {
    metadata: {
      faceBoundingBox: [0.2, 0.1, 0.3, 0.4],
      aspectRatio: 1.5,
      capturedAt: '2024-01-01T00:00:00Z',
      expressionTag: 'smile',
    },
  });

  const scored = gen.scorePhoto(photo);
  const kb = gen.buildKenBurns(scored, prng);

  // Focal point should be near face centre (0.2+0.15, 0.1+0.2) = (0.35, 0.3)
  assert.ok(Math.abs(kb.from.x - 0.35) < 0.15);
  assert.ok(Math.abs(kb.from.y - 0.3) < 0.2);
});

test('ProfileVideoGenerator: validate returns empty array for valid profile', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(5);
  const profile = gen.generate('user-val', photos, { seed: 99 });

  const issues = gen.validate(profile);
  assert.deepEqual(issues, []);
});

test('ProfileVideoGenerator: validate detects wrong resolution', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(2);
  const profile = gen.generate('user-res', photos, { seed: 100 });

  const badProfile = {
    ...profile,
    resolution: { width: 1920, height: 1080 },
  };

  const issues = gen.validate(badProfile);
  assert.ok(issues.some((i) => i.includes('resolution')));
});

test('ProfileVideoGenerator: summarise returns non-empty string', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(3);
  const profile = gen.generate('user-sum', photos, { seed: 50 });
  const summary = gen.summarise(profile);

  assert.ok(summary.length > 0);
  assert.ok(summary.includes('user-sum'));
});

test('ProfileVideoGenerator: same seed produces identical profile IDs', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(5);

  const p1 = gen.generate('user-seed', photos, { seed: 12345 });
  const p2 = gen.generate('user-seed', photos, { seed: 12345 });

  assert.equal(p1.id, p2.id);
  assert.equal(p1.clips.length, p2.clips.length);
  assert.equal(p1.music.id, p2.music.id);
});

test('ProfileVideoGenerator: transition style override applies to all clips', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(5);
  const profile = gen.generate('user-trans', photos, {
    seed: 20,
    transitionStyle: 'crossfade',
  });

  const nonLastClips = profile.clips.slice(0, -1);
  for (const clip of nonLastClips) {
    assert.equal(clip.transitionOut?.kind, 'crossfade');
  }
});

test('ProfileVideoGenerator: clips are indexed sequentially', () => {
  const gen = new ProfileVideoGenerator();
  const photos = makePhotos(5);
  const profile = gen.generate('user-idx', photos, { seed: 30 });

  profile.clips.forEach((clip, i) => {
    assert.equal(clip.index, i);
  });
});

test('ProfileVideoGenerator: photos with no signals default to score ~50', () => {
  const gen = new ProfileVideoGenerator();
  const photo: PhotoAsset = { id: 'no-sig', url: 'https://example.com/x.jpg' };
  const scored = gen.scorePhoto(photo);

  // Default signals: all 50, composite = 50*0.4+50*0.3+50*0.2+50*0.1 = 50
  assert.equal(scored.score, 50);
});
