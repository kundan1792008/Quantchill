/**
 * ProfileVideoGenerator – AI-driven 15-second video dating-profile builder.
 *
 * Takes a user's photo assets plus preference data and produces a
 * `VideoProfile` descriptor that a renderer (e.g. FFmpeg pipeline,
 * React-Native Reanimated canvas, or a WebGL compositor) can consume
 * to produce an MP4 at 720p / 30 fps.
 *
 * Pipeline stages:
 *   1. Photo selection    – score and rank photos; keep top 5.
 *   2. Ken Burns effects  – compute pan/zoom keyframes per photo.
 *   3. Transitions        – pick crossfade / slide / morph between clips.
 *   4. Music selection    – choose a royalty-free backing track by genre.
 *   5. Assembly           – combine everything into a `VideoProfile`.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Total video duration in seconds. */
export const VIDEO_DURATION_S = 15;

/** Output resolution. */
export const VIDEO_WIDTH_PX = 1280;
export const VIDEO_HEIGHT_PX = 720;

/** Number of photos to include in the final reel. */
export const MAX_PHOTOS = 5;

/** Each photo clip is allotted this many seconds (15 s / 5 photos). */
export const CLIP_DURATION_S = VIDEO_DURATION_S / MAX_PHOTOS;

/** Minimum photo score (0–100) required to enter selection pool. */
export const MIN_PHOTO_SCORE = 20;

/** Ken Burns zoom range: start/end scale relative to 1.0. */
const KB_ZOOM_MIN = 1.0;
const KB_ZOOM_MAX = 1.18;

// ─── Public types ─────────────────────────────────────────────────────────────

/** Raw input photo supplied by the caller. */
export interface PhotoAsset {
  /** Unique identifier (e.g. UUID or object-storage key). */
  id: string;
  /** Accessible URL or filesystem path. */
  url: string;
  /**
   * Pre-computed quality signals.  Values are normalised to [0, 100].
   * If a signal is omitted it defaults to 50 (neutral).
   */
  signals?: Partial<PhotoSignals>;
  /** Optional EXIF / ML metadata. */
  metadata?: Partial<PhotoMetadata>;
}

/** Per-photo quality scoring signals (all [0, 100]). */
export interface PhotoSignals {
  /** Sharpness / clarity of the detected face region. */
  faceClarity: number;
  /** Overall image brightness / exposure quality. */
  lightingQuality: number;
  /** Aesthetic score of the background scene. */
  backgroundAesthetics: number;
  /**
   * Expression diversity contribution: how much does this photo differ from
   * others already selected?  Filled in during selection, not by the caller.
   */
  expressionDiversity: number;
}

/** Optional EXIF / ML-derived metadata supplied with the photo. */
export interface PhotoMetadata {
  /** Aspect ratio (width / height). */
  aspectRatio: number;
  /** ISO 8601 capture timestamp. */
  capturedAt: string;
  /** Bounding box of the primary face [x, y, w, h] as fraction of image. */
  faceBoundingBox: readonly [number, number, number, number];
  /** Facial action-unit tag for dominant expression. */
  expressionTag: string;
}

/** A photo that has been scored and selected for the reel. */
export interface ScoredPhoto {
  photo: PhotoAsset;
  /** Composite quality score [0, 100]. */
  score: number;
  /** Broken-down signal scores that contributed to `score`. */
  signals: PhotoSignals;
}

// ─── Ken Burns ────────────────────────────────────────────────────────────────

/** Direction of pan motion for Ken Burns effect. */
export type PanDirection = 'left' | 'right' | 'up' | 'down' | 'none';

/** Zoom direction: zooming in or pulling out. */
export type ZoomDirection = 'in' | 'out';

/**
 * Describes how the camera should move over a single photo clip.
 * Coordinates are normalised: (0, 0) = top-left, (1, 1) = bottom-right.
 */
export interface KenBurnsKeyframe {
  /** Normalised horizontal centre [0, 1]. */
  x: number;
  /** Normalised vertical centre [0, 1]. */
  y: number;
  /** Scale relative to base fit (1.0 = fitted, > 1.0 = zoomed in). */
  scale: number;
  /** Easing function name for the transition to this keyframe. */
  easing: 'ease-in-out' | 'linear' | 'ease-in' | 'ease-out';
}

/** Full Ken Burns animation descriptor for one clip. */
export interface KenBurnsEffect {
  /** Starting keyframe (applied at t=0 of the clip). */
  from: KenBurnsKeyframe;
  /** Ending keyframe (applied at t=clipDuration). */
  to: KenBurnsKeyframe;
  /** Human-readable label for debugging. */
  label: string;
}

// ─── Transitions ─────────────────────────────────────────────────────────────

export type TransitionKind = 'crossfade' | 'slide-left' | 'slide-right' | 'slide-up' | 'morph';

/** Transition between two consecutive clips. */
export interface VideoTransition {
  /** Which transition to use. */
  kind: TransitionKind;
  /** Duration of the overlap / blend in seconds. */
  durationS: number;
  /**
   * Easing curve applied to the blend progress (0 → 1).
   */
  easing: 'ease-in-out' | 'linear';
}

// ─── Music ────────────────────────────────────────────────────────────────────

export type MusicGenre = 'chill' | 'pop' | 'ambient' | 'jazz' | 'acoustic';

/** Metadata for a royalty-free backing track. */
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  genre: MusicGenre;
  /** Duration of the original track in seconds. */
  originalDurationS: number;
  /** URL/path to audio file. */
  url: string;
  /**
   * Suggested cue-in point in seconds so the best part of the song plays
   * during the 15-second reel.
   */
  cueInS: number;
  /** Target loudness for mixing in LUFS. */
  lufsTarget: number;
}

// ─── VideoClip ────────────────────────────────────────────────────────────────

/** One photo-based clip as it appears in the assembled timeline. */
export interface VideoClip {
  /** Position in the timeline (0-indexed). */
  index: number;
  /** Scored photo this clip is built from. */
  scoredPhoto: ScoredPhoto;
  /** Camera movement animation. */
  kenBurns: KenBurnsEffect;
  /** Duration of this clip's visible window (excluding transition overlap). */
  durationS: number;
  /** Transition OUT of this clip (undefined for the last clip). */
  transitionOut?: VideoTransition;
}

// ─── VideoProfile ─────────────────────────────────────────────────────────────

/** The complete video-profile descriptor ready for rendering. */
export interface VideoProfile {
  /** Unique ID for this generation request. */
  id: string;
  /** User whose profile this reel represents. */
  userId: string;
  /** Ordered list of clips. */
  clips: VideoClip[];
  /** Background music track. */
  music: MusicTrack;
  /** Total assembled duration in seconds. */
  totalDurationS: number;
  /** Output resolution. */
  resolution: { width: number; height: number };
  /** ISO 8601 timestamp of generation. */
  generatedAt: string;
}

// ─── Generation options ───────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Preferred music genre.  Defaults to 'chill'. */
  musicGenre?: MusicGenre;
  /**
   * Preferred transition style.  When 'auto' (default) the generator varies
   * transitions for visual interest.
   */
  transitionStyle?: TransitionKind | 'auto';
  /** Override the random seed used for Ken Burns variation (useful in tests). */
  seed?: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Seeded pseudo-random number generator (LCG). */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Clamp a value to [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Resolve a partial PhotoSignals object, filling defaults. */
function resolveSignals(partial?: Partial<PhotoSignals>): PhotoSignals {
  return {
    faceClarity: partial?.faceClarity ?? 50,
    lightingQuality: partial?.lightingQuality ?? 50,
    backgroundAesthetics: partial?.backgroundAesthetics ?? 50,
    expressionDiversity: partial?.expressionDiversity ?? 50,
  };
}

// ─── Music catalogue ──────────────────────────────────────────────────────────

const MUSIC_CATALOGUE: MusicTrack[] = [
  {
    id: 'chill-001',
    title: 'Sunset Haze',
    artist: 'QuantBeats',
    genre: 'chill',
    originalDurationS: 180,
    url: '/assets/music/chill-001.mp3',
    cueInS: 8,
    lufsTarget: -14,
  },
  {
    id: 'chill-002',
    title: 'Golden Hour',
    artist: 'LoFi Waves',
    genre: 'chill',
    originalDurationS: 210,
    url: '/assets/music/chill-002.mp3',
    cueInS: 0,
    lufsTarget: -14,
  },
  {
    id: 'pop-001',
    title: 'Electric Spark',
    artist: 'NeonPop',
    genre: 'pop',
    originalDurationS: 195,
    url: '/assets/music/pop-001.mp3',
    cueInS: 12,
    lufsTarget: -12,
  },
  {
    id: 'pop-002',
    title: 'Summer Rush',
    artist: 'Wavelength',
    genre: 'pop',
    originalDurationS: 220,
    url: '/assets/music/pop-002.mp3',
    cueInS: 16,
    lufsTarget: -12,
  },
  {
    id: 'ambient-001',
    title: 'Drift',
    artist: 'CloudMind',
    genre: 'ambient',
    originalDurationS: 300,
    url: '/assets/music/ambient-001.mp3',
    cueInS: 0,
    lufsTarget: -18,
  },
  {
    id: 'ambient-002',
    title: 'Morning Mist',
    artist: 'Serenity Lab',
    genre: 'ambient',
    originalDurationS: 280,
    url: '/assets/music/ambient-002.mp3',
    cueInS: 20,
    lufsTarget: -18,
  },
  {
    id: 'jazz-001',
    title: 'Blue Velvet Café',
    artist: 'Quarter Note',
    genre: 'jazz',
    originalDurationS: 240,
    url: '/assets/music/jazz-001.mp3',
    cueInS: 4,
    lufsTarget: -14,
  },
  {
    id: 'acoustic-001',
    title: 'Open Road',
    artist: 'Porch Sessions',
    genre: 'acoustic',
    originalDurationS: 190,
    url: '/assets/music/acoustic-001.mp3',
    cueInS: 0,
    lufsTarget: -15,
  },
];

// ─── Transition presets ───────────────────────────────────────────────────────

const TRANSITION_PRESETS: readonly TransitionKind[] = [
  'crossfade',
  'slide-left',
  'slide-right',
  'slide-up',
  'morph',
];

// ─── ProfileVideoGenerator ────────────────────────────────────────────────────

/**
 * Stateless service — call `generate()` with a user's photos and preferences
 * to receive a fully-described `VideoProfile` render job.
 */
export class ProfileVideoGenerator {
  // ── Photo scoring ──────────────────────────────────────────────────────────

  /**
   * Compute a composite quality score [0, 100] for one photo.
   *
   * Weights:
   *   faceClarity          40%
   *   lightingQuality      30%
   *   backgroundAesthetics 20%
   *   expressionDiversity  10%
   */
  scorePhoto(photo: PhotoAsset): ScoredPhoto {
    const s = resolveSignals(photo.signals);
    const score =
      s.faceClarity * 0.4 +
      s.lightingQuality * 0.3 +
      s.backgroundAesthetics * 0.2 +
      s.expressionDiversity * 0.1;

    return { photo, score: clamp(score, 0, 100), signals: s };
  }

  /**
   * Score all provided photos and select the top `MAX_PHOTOS`, enforcing
   * expression diversity so the reel does not look monotonous.
   *
   * The diversity re-scoring pass reduces the score of photos whose
   * `expressionTag` has already been selected, encouraging variety.
   */
  selectTopPhotos(photos: PhotoAsset[]): ScoredPhoto[] {
    if (photos.length === 0) return [];

    // Initial scoring pass.
    const scored = photos.map((p) => this.scorePhoto(p));

    // Filter out photos that fall below the minimum quality bar.
    const eligible = scored.filter((s) => s.score >= MIN_PHOTO_SCORE);

    // If fewer eligible photos remain than MAX_PHOTOS, relax the filter.
    const pool = eligible.length >= 2 ? eligible : scored;

    // Sort descending by score.
    pool.sort((a, b) => b.score - a.score);

    // Diversity pass: penalise repeated expression tags.
    const selectedTags = new Set<string>();
    const selected: ScoredPhoto[] = [];

    for (const candidate of pool) {
      if (selected.length >= MAX_PHOTOS) break;

      const tag = candidate.photo.metadata?.expressionTag ?? 'neutral';
      let adjustedScore = candidate.score;

      if (selectedTags.has(tag)) {
        // Penalise repeated expressions by 25 points.
        adjustedScore = Math.max(0, adjustedScore - 25);
      }

      selected.push({ ...candidate, score: adjustedScore });
      selectedTags.add(tag);
    }

    // Re-sort after diversity adjustment.
    selected.sort((a, b) => b.score - a.score);

    return selected.slice(0, MAX_PHOTOS);
  }

  // ── Ken Burns ──────────────────────────────────────────────────────────────

  /**
   * Generate a Ken Burns effect for a clip.
   *
   * The focal point of the starting keyframe is biased toward the face
   * bounding box (if available).  The ending keyframe subtly shifts the
   * crop to create the illusion of a camera operator composing the shot.
   */
  buildKenBurns(photo: ScoredPhoto, prng: () => number): KenBurnsEffect {
    const meta = photo.photo.metadata;

    // Default focal centre: image centre.
    let faceX = 0.5;
    let faceY = 0.4; // Slightly above centre — compositional rule of thirds.

    if (meta?.faceBoundingBox) {
      const [bx, by, bw, bh] = meta.faceBoundingBox;
      faceX = clamp(bx + bw / 2, 0.15, 0.85);
      faceY = clamp(by + bh / 2, 0.15, 0.85);
    }

    // Randomise zoom direction.
    const zoomDirection: ZoomDirection = prng() > 0.5 ? 'in' : 'out';

    const startScale =
      zoomDirection === 'in'
        ? KB_ZOOM_MIN
        : KB_ZOOM_MIN + (KB_ZOOM_MAX - KB_ZOOM_MIN) * prng();

    const endScale =
      zoomDirection === 'in'
        ? KB_ZOOM_MIN + (KB_ZOOM_MAX - KB_ZOOM_MIN) * (0.5 + prng() * 0.5)
        : KB_ZOOM_MIN;

    // Pan: slight drift away from the face centre for natural feel.
    const driftX = (prng() - 0.5) * 0.08;
    const driftY = (prng() - 0.5) * 0.06;

    const fromKf: KenBurnsKeyframe = {
      x: clamp(faceX, 0.1, 0.9),
      y: clamp(faceY, 0.1, 0.9),
      scale: startScale,
      easing: 'ease-in-out',
    };

    const toKf: KenBurnsKeyframe = {
      x: clamp(faceX + driftX, 0.1, 0.9),
      y: clamp(faceY + driftY, 0.1, 0.9),
      scale: endScale,
      easing: 'ease-in-out',
    };

    const label =
      `zoom-${zoomDirection} ` +
      `(${startScale.toFixed(2)}→${endScale.toFixed(2)}) ` +
      `pan-(${driftX.toFixed(3)},${driftY.toFixed(3)})`;

    return { from: fromKf, to: toKf, label };
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  /**
   * Select the transition between clip `index` and clip `index + 1`.
   *
   * When `style` is 'auto' the transitions alternate through the preset
   * list for visual variety.  Otherwise the caller's preference is used
   * for all clips.
   */
  buildTransition(
    style: TransitionKind | 'auto',
    index: number,
    prng: () => number,
  ): VideoTransition {
    let kind: TransitionKind;

    if (style === 'auto') {
      // Rotate through presets, occasionally inserting a morph.
      const roll = prng();
      if (roll < 0.15) {
        kind = 'morph';
      } else {
        kind = TRANSITION_PRESETS[index % (TRANSITION_PRESETS.length - 1)]!;
      }
    } else {
      kind = style;
    }

    // Morph transitions are slightly longer.
    const durationS = kind === 'morph' ? 0.6 : 0.4;

    return { kind, durationS, easing: 'ease-in-out' };
  }

  // ── Music ──────────────────────────────────────────────────────────────────

  /**
   * Select the best matching track from the catalogue for a given genre.
   * When multiple tracks match, pick one deterministically via `prng`.
   */
  selectMusic(genre: MusicGenre, prng: () => number): MusicTrack {
    const matches = MUSIC_CATALOGUE.filter((t) => t.genre === genre);
    const pool = matches.length > 0 ? matches : MUSIC_CATALOGUE;
    const idx = Math.floor(prng() * pool.length);
    return pool[idx]!;
  }

  // ── Assembly ───────────────────────────────────────────────────────────────

  /**
   * Main entry point.  Accepts any number of raw `PhotoAsset` objects plus
   * optional generation preferences.
   *
   * Returns a fully-described `VideoProfile` that a renderer can consume
   * without any additional business logic.
   */
  generate(
    userId: string,
    photos: PhotoAsset[],
    options: GenerateOptions = {},
  ): VideoProfile {
    const seed = options.seed ?? Date.now();
    const prng = makePrng(seed);

    const genre = options.musicGenre ?? 'chill';
    const transitionStyle = options.transitionStyle ?? 'auto';

    // 1. Select top photos.
    const selectedPhotos = this.selectTopPhotos(photos);

    // 2. Build clips.
    const clips: VideoClip[] = selectedPhotos.map((sp, i) => {
      const kenBurns = this.buildKenBurns(sp, prng);
      const isLast = i === selectedPhotos.length - 1;
      const transitionOut = isLast
        ? undefined
        : this.buildTransition(transitionStyle, i, prng);

      return {
        index: i,
        scoredPhoto: sp,
        kenBurns,
        durationS: CLIP_DURATION_S,
        transitionOut,
      };
    });

    // 3. Select music.
    const music = this.selectMusic(genre, prng);

    // 4. Assemble.
    return {
      id: `vp-${userId}-${seed}`,
      userId,
      clips,
      music,
      totalDurationS: VIDEO_DURATION_S,
      resolution: { width: VIDEO_WIDTH_PX, height: VIDEO_HEIGHT_PX },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  /**
   * Return a human-readable text summary of a generated `VideoProfile` for
   * debugging / logging purposes.
   */
  summarise(profile: VideoProfile): string {
    const lines: string[] = [
      `VideoProfile ${profile.id}`,
      `  User : ${profile.userId}`,
      `  Clips: ${profile.clips.length}`,
      `  Music: "${profile.music.title}" by ${profile.music.artist} [${profile.music.genre}]`,
      `  Total: ${profile.totalDurationS}s @ ${profile.resolution.width}×${profile.resolution.height}`,
      `  Generated: ${profile.generatedAt}`,
      '',
      '  Clips detail:',
    ];

    for (const clip of profile.clips) {
      const t = clip.transitionOut
        ? ` → [${clip.transitionOut.kind} ${clip.transitionOut.durationS}s]`
        : ' → [END]';
      lines.push(
        `    [${clip.index}] score=${clip.scoredPhoto.score.toFixed(1)} ` +
          `kb=${clip.kenBurns.label}${t}`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Validate a `VideoProfile` and return any issues found.
   * Returns an empty array when the profile is valid.
   */
  validate(profile: VideoProfile): string[] {
    const issues: string[] = [];

    if (profile.clips.length === 0) {
      issues.push('No clips in profile.');
    }

    if (profile.totalDurationS !== VIDEO_DURATION_S) {
      issues.push(
        `Expected totalDurationS=${VIDEO_DURATION_S}, got ${profile.totalDurationS}.`,
      );
    }

    if (
      profile.resolution.width !== VIDEO_WIDTH_PX ||
      profile.resolution.height !== VIDEO_HEIGHT_PX
    ) {
      issues.push(
        `Expected resolution ${VIDEO_WIDTH_PX}×${VIDEO_HEIGHT_PX}, ` +
          `got ${profile.resolution.width}×${profile.resolution.height}.`,
      );
    }

    for (const clip of profile.clips) {
      if (clip.kenBurns.from.scale < KB_ZOOM_MIN) {
        issues.push(`Clip ${clip.index}: start scale below minimum.`);
      }
      if (clip.kenBurns.to.scale < KB_ZOOM_MIN) {
        issues.push(`Clip ${clip.index}: end scale below minimum.`);
      }
    }

    return issues;
  }
}
