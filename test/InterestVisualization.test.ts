import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InterestVisualization,
  InterestVisualizationInput,
  MAX_WORDCLOUD_INTERESTS,
  WORDCLOUD_STAGGER_S,
  HEATMAP_DAYS,
} from '../src/services/InterestVisualization';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInput(
  overrides: Partial<InterestVisualizationInput> = {},
): InterestVisualizationInput {
  return {
    userId: 'user-1',
    interests: {
      music: 90,
      travel: 80,
      coffee: 70,
      hiking: 60,
      tech: 50,
      art: 45,
      gaming: 40,
      yoga: 35,
      cooking: 30,
      books: 25,
    },
    dailyActivity: [10, 20, 15, 25, 30, 60, 55],
    location: 'San Francisco, CA',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('InterestVisualization: buildOverlayPlan returns a valid plan', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput());

  assert.equal(plan.userId, 'user-1');
  assert.ok(plan.wordcloud.words.length > 0);
  assert.ok(plan.heatmap.days.length === HEATMAP_DAYS);
  assert.ok(typeof plan.generatedAt === 'string');
});

test('InterestVisualization: wordcloud limits to MAX_WORDCLOUD_INTERESTS', () => {
  const viz = new InterestVisualization();
  // More than MAX_WORDCLOUD_INTERESTS interests
  const manyInterests: Record<string, number> = {};
  for (let i = 0; i < 15; i++) {
    manyInterests[`interest-${i}`] = 100 - i;
  }

  const plan = viz.buildOverlayPlan({
    userId: 'u',
    interests: manyInterests,
  });

  assert.ok(plan.wordcloud.words.length <= MAX_WORDCLOUD_INTERESTS);
});

test('InterestVisualization: wordcloud words are sorted by weight descending', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput());

  const words = plan.wordcloud.words;
  for (let i = 1; i < words.length; i++) {
    assert.ok(
      words[i - 1]!.weight >= words[i]!.weight,
      'words should be sorted by weight descending',
    );
  }
});

test('InterestVisualization: wordcloud animation delays increase with index', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput());

  const words = plan.wordcloud.words;
  for (let i = 1; i < words.length; i++) {
    assert.ok(
      words[i]!.animationDelayS > words[i - 1]!.animationDelayS,
      'animation delays should be strictly increasing',
    );
  }
});

test('InterestVisualization: wordcloud stagger matches WORDCLOUD_STAGGER_S', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput());
  const words = plan.wordcloud.words;

  if (words.length >= 2) {
    const diff = words[1]!.animationDelayS - words[0]!.animationDelayS;
    assert.ok(Math.abs(diff - WORDCLOUD_STAGGER_S) < 0.001);
  }
});

test('InterestVisualization: wordcloud total duration is correct', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput());

  const expected =
    (plan.wordcloud.words.length - 1) * WORDCLOUD_STAGGER_S + 0.35; // WORDCLOUD_POP_DURATION_S
  assert.ok(Math.abs(plan.wordcloud.totalDurationS - expected) < 0.001);
});

test('InterestVisualization: heatmap has 7 days', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput());

  assert.equal(plan.heatmap.days.length, HEATMAP_DAYS);
});

test('InterestVisualization: heatmap normalises max level to 1.0', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(
    makeInput({ dailyActivity: [10, 20, 30, 40, 50, 100, 5] }),
  );

  const maxLevel = Math.max(...plan.heatmap.days.map((d) => d.level));
  assert.ok(Math.abs(maxLevel - 1.0) < 0.001, 'max level should be 1.0');
});

test('InterestVisualization: heatmap banner for weekend peaks', () => {
  const viz = new InterestVisualization();
  // Saturday (index 5) and Sunday (index 6) are clearly peak
  const plan = viz.buildOverlayPlan(
    makeInput({ dailyActivity: [1, 1, 1, 1, 1, 100, 90] }),
  );

  assert.equal(plan.heatmap.bannerText, 'Most active on weekends');
});

test('InterestVisualization: heatmap banner for single peak day', () => {
  const viz = new InterestVisualization();
  // Only Monday (index 0) peaks
  const plan = viz.buildOverlayPlan(
    makeInput({ dailyActivity: [100, 5, 5, 5, 5, 5, 5] }),
  );

  assert.ok(plan.heatmap.bannerText.includes('Monday'));
});

test('InterestVisualization: location tag is built when location provided', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput({ location: 'New York' }));

  assert.ok(plan.locationTag !== null);
  assert.equal(plan.locationTag!.label, 'New York');
});

test('InterestVisualization: location tag is null when location is absent', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(
    makeInput({ location: undefined }),
  );

  assert.equal(plan.locationTag, null);
});

test('InterestVisualization: location tag is null for empty string location', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput({ location: '   ' }));

  assert.equal(plan.locationTag, null);
});

test('InterestVisualization: overlay timing is non-overlapping', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput({ overlayStartAtS: 1 }));

  // Heatmap should start after wordcloud ends
  const wordcloudEnd =
    plan.wordcloud.startAtS + plan.wordcloud.totalDurationS;
  assert.ok(
    plan.heatmap.startAtS >= wordcloudEnd,
    'heatmap should start after wordcloud ends',
  );
});

test('InterestVisualization: overlayStartAtS shifts wordcloud start time', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput({ overlayStartAtS: 5 }));

  assert.equal(plan.wordcloud.startAtS, 5);
});

test('InterestVisualization: topInterests returns correct count', () => {
  const viz = new InterestVisualization();
  const interests = { music: 90, travel: 80, coffee: 70, hiking: 60 };

  const top3 = viz.topInterests(interests, 3);
  assert.equal(top3.length, 3);
  assert.equal(top3[0], 'music');
  assert.equal(top3[1], 'travel');
  assert.equal(top3[2], 'coffee');
});

test('InterestVisualization: topInterests excludes zero-weight interests', () => {
  const viz = new InterestVisualization();
  const interests = { music: 90, silent: 0, travel: 80 };

  const top = viz.topInterests(interests, 5);
  assert.ok(!top.includes('silent'));
});

test('InterestVisualization: music interest resolves to music icon', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan({
    userId: 'u',
    interests: { music: 90 },
  });

  const musicWord = plan.wordcloud.words.find((w) => w.text === 'music');
  assert.ok(musicWord !== undefined);
  assert.equal(musicWord!.icon, '🎵');
});

test('InterestVisualization: unknown interest resolves to default icon', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan({
    userId: 'u',
    interests: { xylophoneCollecting: 70 },
  });

  const word = plan.wordcloud.words[0];
  assert.ok(word !== undefined);
  assert.equal(word!.icon, '✨');
});

test('InterestVisualization: wordcloud assigns distinct colours', () => {
  const viz = new InterestVisualization();
  const interests: Record<string, number> = {};
  for (let i = 0; i < 8; i++) interests[`tag${i}`] = 100 - i;

  const plan = viz.buildOverlayPlan({ userId: 'u', interests });
  const colors = plan.wordcloud.words.map((w) => w.color);
  const unique = new Set(colors);

  // We have 8 colours in the palette, so all 8 words should get distinct colours
  assert.equal(unique.size, 8);
});

test('InterestVisualization: summarise returns non-empty string', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan(makeInput());
  const summary = viz.summarise(plan);

  assert.ok(summary.length > 0);
  assert.ok(summary.includes('user-1'));
});

test('InterestVisualization: heatmap defaults when no activity data provided', () => {
  const viz = new InterestVisualization();
  const plan = viz.buildOverlayPlan({
    userId: 'u',
    interests: { music: 50 },
  });

  // Should produce 7 days all with equal level (all 1/1 = 1.0)
  assert.equal(plan.heatmap.days.length, HEATMAP_DAYS);
});

test('InterestVisualization: hourlyActivity is aggregated to days when dailyActivity absent', () => {
  const viz = new InterestVisualization();
  const hourly = new Array(24).fill(0);
  // Concentrate activity in first 3 hours (maps to day 0)
  hourly[0] = 100;
  hourly[1] = 100;
  hourly[2] = 100;

  const plan = viz.buildOverlayPlan({
    userId: 'u',
    interests: { music: 50 },
    hourlyActivity: hourly,
  });

  // Day 0 (Mon) should have the highest level
  const maxDay = plan.heatmap.days.reduce((best, d) =>
    d.level > best.level ? d : best,
  );
  assert.equal(maxDay.day, 'Monday');
});
