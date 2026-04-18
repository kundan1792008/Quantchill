'use client';

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useId,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MusicGenre = 'chill' | 'pop' | 'ambient' | 'jazz' | 'acoustic';

export type TransitionKind =
  | 'crossfade'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'morph';

export interface VideoClipDescriptor {
  /** Index within the clip array (0-based). */
  index: number;
  /** URL of the photo or pre-rendered clip. */
  sourceUrl: string;
  /** Display name / alt text for accessibility. */
  altText?: string;
  /** Duration of this clip in seconds. */
  durationS: number;
  /** Transition kind coming OUT of this clip. */
  transitionOut?: TransitionKind;
}

export interface MusicTrackDescriptor {
  id: string;
  title: string;
  artist: string;
  genre: MusicGenre;
  url: string;
  cueInS?: number;
}

export interface WordcloudWord {
  text: string;
  weight: number;
  icon: string;
  color: string;
  fontSizePx: number;
  animationDelayS: number;
}

export interface QuoteCard {
  index: number;
  text: string;
  startAtS: number;
  accentColor: string;
  typingAnimation: {
    totalChars: number;
    speedCps: number;
    totalDurationS: number;
  };
}

export interface ActivityDay {
  day: string;
  level: number;
  isPeak: boolean;
}

export interface VideoProfileData {
  /** Unique profile ID. */
  id: string;
  /** User display name. */
  userName: string;
  /** Age (optional). */
  age?: number;
  /** Array of video clips / photo descriptors. */
  clips: VideoClipDescriptor[];
  /** Background music (optional — profile auto-plays muted when absent). */
  music?: MusicTrackDescriptor;
  /** Interests for wordcloud overlay. */
  interests?: WordcloudWord[];
  /** Activity heatmap data. */
  activityDays?: ActivityDay[];
  /** Activity banner text. */
  activityBannerText?: string;
  /** Location display label. */
  location?: string;
  /** Conversation quote cards. */
  quoteCards?: QuoteCard[];
  /** Total reel duration in seconds. */
  totalDurationS: number;
}

export interface VideoProfilePlayerProps {
  /** Profile data to display. */
  profile: VideoProfileData;
  /** Called when the user taps "Like" in the reel. */
  onLike?: () => void;
  /** Called when the user taps "Skip". */
  onSkip?: () => void;
  /** Called when the view counter increments. */
  onView?: (viewCount: number) => void;
  /** Initial view count (e.g., loaded from the server). */
  initialViewCount?: number;
  /** Whether to start with the "Create My Video" wizard open. */
  startInWizardMode?: boolean;
  /** Callback when the user completes the wizard. */
  onWizardComplete?: (preferences: VideoWizardPreferences) => void;
  /** CSS class applied to the root element. */
  className?: string;
}

export interface VideoWizardPreferences {
  musicGenre: MusicGenre;
  transitionStyle: TransitionKind | 'auto';
  showInterests: boolean;
  showActivity: boolean;
  showLocation: boolean;
  showQuotes: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CLIP_DURATION_S = 3;
const ACTIVITY_BAR_MAX_HEIGHT_PX = 32;
const ACTIVITY_DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const GENRE_LABELS: Record<MusicGenre, string> = {
  chill: '🌊 Chill',
  pop: '🎵 Pop',
  ambient: '🌌 Ambient',
  jazz: '🎷 Jazz',
  acoustic: '🎸 Acoustic',
};

const TRANSITION_LABELS: Record<TransitionKind | 'auto', string> = {
  auto: '✨ Auto',
  crossfade: '🌫️ Crossfade',
  'slide-left': '◀️ Slide Left',
  'slide-right': '▶️ Slide Right',
  'slide-up': '⬆️ Slide Up',
  morph: '🔮 Morph',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

// ── WordcloudOverlay ──────────────────────────────────────────────────────────

function WordcloudOverlay({ words }: { words: WordcloudWord[] }) {
  return (
    <div className="absolute inset-x-0 bottom-16 flex flex-wrap justify-center gap-2 px-4 pointer-events-none">
      <AnimatePresence>
        {words.map((word) => (
          <motion.div
            key={word.text}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{
              delay: word.animationDelayS,
              duration: 0.35,
              type: 'spring',
              stiffness: 400,
              damping: 15,
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-full backdrop-blur-sm bg-black/40 border border-white/10"
            style={{
              fontSize: `${Math.max(11, Math.min(word.fontSizePx * 0.55, 18))}px`,
              color: word.color,
              borderColor: word.color + '55',
            }}
          >
            <span>{word.icon}</span>
            <span className="font-medium">{word.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ── ActivityHeatmapOverlay ────────────────────────────────────────────────────

function ActivityHeatmapOverlay({
  days,
  bannerText,
}: {
  days: ActivityDay[];
  bannerText?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.4 }}
      className="absolute bottom-4 inset-x-4 rounded-2xl bg-black/60 backdrop-blur-sm border border-white/10 p-3 pointer-events-none"
    >
      {bannerText && (
        <p className="text-white/80 text-xs font-medium text-center mb-2">
          {bannerText}
        </p>
      )}
      <div className="flex items-end justify-between gap-1">
        {days.map((day, i) => (
          <div key={i} className="flex flex-col items-center gap-1 flex-1">
            <div
              className="w-full rounded-sm transition-all duration-500"
              style={{
                height: `${Math.max(4, day.level * ACTIVITY_BAR_MAX_HEIGHT_PX)}px`,
                backgroundColor: day.isPeak ? '#a78bfa' : '#ffffff33',
              }}
            />
            <span
              className="text-[9px] font-medium"
              style={{ color: day.isPeak ? '#a78bfa' : '#ffffff55' }}
            >
              {ACTIVITY_DAY_LABELS[i] ?? ''}
            </span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ── LocationPinOverlay ────────────────────────────────────────────────────────

function LocationPinOverlay({ label }: { label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0, y: -20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0 }}
      transition={{ duration: 0.5, type: 'spring', stiffness: 300, damping: 18 }}
      className="absolute top-20 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none"
    >
      <div className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm border border-white/15">
        <span className="text-sm">📍</span>
        <span className="text-white text-xs font-semibold">{label}</span>
      </div>
      {/* Pulse rings */}
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="absolute rounded-full border border-white/30"
          initial={{ width: 8, height: 8, opacity: 0.8 }}
          animate={{ width: 40, height: 40, opacity: 0 }}
          transition={{
            delay: i * 0.3,
            duration: 1.2,
            repeat: Infinity,
            repeatDelay: 0.9,
          }}
          style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
        />
      ))}
    </motion.div>
  );
}

// ── QuoteCardOverlay ──────────────────────────────────────────────────────────

function QuoteCardOverlay({ card }: { card: QuoteCard }) {
  const [displayedText, setDisplayedText] = useState('');

  useEffect(() => {
    setDisplayedText('');
    if (!card.text) return;

    const chars = card.text.split('');
    let idx = 0;
    const msPerChar = 1000 / card.typingAnimation.speedCps;

    const timer = setInterval(() => {
      idx++;
      setDisplayedText(chars.slice(0, idx).join(''));
      if (idx >= chars.length) clearInterval(timer);
    }, msPerChar);

    return () => clearInterval(timer);
  }, [card.text, card.typingAnimation.speedCps]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.92, y: -10 }}
      transition={{ duration: 0.4, type: 'spring', stiffness: 250, damping: 20 }}
      className="absolute inset-x-6 top-24 rounded-2xl bg-black/70 backdrop-blur-sm border p-4 pointer-events-none"
      style={{ borderColor: card.accentColor + '88' }}
    >
      <div
        className="absolute top-0 left-0 w-1 h-full rounded-l-2xl"
        style={{ backgroundColor: card.accentColor }}
      />
      <p className="text-white text-sm leading-relaxed pl-3">
        {displayedText}
        <motion.span
          animate={{ opacity: [1, 0, 1] }}
          transition={{ repeat: Infinity, duration: 0.8 }}
          className="inline-block w-0.5 h-4 bg-white/80 ml-0.5 align-middle"
        />
      </p>
    </motion.div>
  );
}

// ── EngagementBar ─────────────────────────────────────────────────────────────

function EngagementBar({
  viewCount,
  isMuted,
  onToggleMute,
  onLike,
  onSkip,
}: {
  viewCount: number;
  isMuted: boolean;
  onToggleMute: () => void;
  onLike?: () => void;
  onSkip?: () => void;
}) {
  return (
    <div className="absolute bottom-0 inset-x-0 z-20 flex items-center justify-between px-4 pb-safe-bottom py-3 bg-gradient-to-t from-black/80 to-transparent">
      {/* View count */}
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 backdrop-blur-sm">
        <span className="text-white/60 text-xs">👁</span>
        <span className="text-white/80 text-xs font-medium">
          {viewCount.toLocaleString()}
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3">
        {onSkip && (
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={onSkip}
            className="w-11 h-11 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center text-xl"
            aria-label="Skip"
          >
            ❌
          </motion.button>
        )}

        {onLike && (
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={onLike}
            className="w-12 h-12 rounded-full bg-pink-500/90 border border-pink-400 flex items-center justify-center text-xl shadow-lg shadow-pink-500/30"
            aria-label="Like"
          >
            ❤️
          </motion.button>
        )}

        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={onToggleMute}
          className="w-11 h-11 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center text-lg"
          aria-label={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? '🔇' : '🔊'}
        </motion.button>
      </div>
    </div>
  );
}

// ── ClipProgress ──────────────────────────────────────────────────────────────

function ClipProgress({
  total,
  activeIndex,
  progressFraction,
}: {
  total: number;
  activeIndex: number;
  progressFraction: number;
}) {
  return (
    <div className="absolute top-3 inset-x-3 z-20 flex gap-1">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className="flex-1 h-0.5 rounded-full bg-white/25 overflow-hidden"
        >
          {i < activeIndex && (
            <div className="h-full w-full bg-white/80" />
          )}
          {i === activeIndex && (
            <motion.div
              className="h-full bg-white"
              initial={{ width: '0%' }}
              animate={{ width: `${progressFraction * 100}%` }}
              transition={{ duration: 0, ease: 'linear' }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── UserNameBadge ─────────────────────────────────────────────────────────────

function UserNameBadge({
  userName,
  age,
}: {
  userName: string;
  age?: number;
}) {
  return (
    <div className="absolute top-8 inset-x-0 z-10 flex flex-col items-center">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="flex items-baseline gap-2 px-4 py-1.5 rounded-full bg-black/50 backdrop-blur-sm border border-white/10"
      >
        <span className="text-white font-bold text-base">{userName}</span>
        {age !== undefined && (
          <span className="text-white/60 text-sm">{age}</span>
        )}
      </motion.div>
    </div>
  );
}

// ── CreateWizard ──────────────────────────────────────────────────────────────

function CreateWizard({
  onComplete,
  onCancel,
}: {
  onComplete: (prefs: VideoWizardPreferences) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [prefs, setPrefs] = useState<VideoWizardPreferences>({
    musicGenre: 'chill',
    transitionStyle: 'auto',
    showInterests: true,
    showActivity: true,
    showLocation: true,
    showQuotes: true,
  });

  const GENRES: MusicGenre[] = ['chill', 'pop', 'ambient', 'jazz', 'acoustic'];
  const TRANSITIONS: Array<TransitionKind | 'auto'> = [
    'auto',
    'crossfade',
    'slide-left',
    'slide-right',
    'slide-up',
    'morph',
  ];

  function toggleOverlay(key: keyof VideoWizardPreferences) {
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 60 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 60 }}
      className="absolute inset-0 z-50 bg-black/95 backdrop-blur-sm flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-safe-top py-4 border-b border-white/10">
        <button
          onClick={onCancel}
          className="text-white/60 text-sm hover:text-white transition-colors"
        >
          ✕ Cancel
        </button>
        <h2 className="text-white font-bold text-base">Create My Video</h2>
        <div className="text-white/40 text-sm">{step + 1}/3</div>
      </div>

      {/* Step indicator */}
      <div className="flex gap-1 px-5 py-3">
        {([0, 1, 2] as const).map((s) => (
          <div
            key={s}
            className={[
              'flex-1 h-1 rounded-full transition-colors duration-300',
              s <= step ? 'bg-violet-500' : 'bg-white/15',
            ].join(' ')}
          />
        ))}
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <AnimatePresence mode="wait">
          {step === 0 && (
            <motion.div
              key="step0"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <h3 className="text-white font-semibold text-sm mb-1">
                🎵 Choose your music genre
              </h3>
              <p className="text-white/40 text-xs mb-4">
                Background music plays when viewers unmute your profile.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {GENRES.map((g) => (
                  <button
                    key={g}
                    onClick={() => setPrefs((p) => ({ ...p, musicGenre: g }))}
                    className={[
                      'py-3 px-4 rounded-xl border text-sm font-medium transition-all',
                      prefs.musicGenre === g
                        ? 'bg-violet-500/20 border-violet-500 text-violet-300'
                        : 'bg-white/5 border-white/15 text-white/70 hover:border-white/30',
                    ].join(' ')}
                  >
                    {GENRE_LABELS[g]}
                  </button>
                ))}
              </div>
            </motion.div>
          )}

          {step === 1 && (
            <motion.div
              key="step1"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <h3 className="text-white font-semibold text-sm mb-1">
                🎬 Choose transition style
              </h3>
              <p className="text-white/40 text-xs mb-4">
                How your photos transition between each other.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {TRANSITIONS.map((t) => (
                  <button
                    key={t}
                    onClick={() =>
                      setPrefs((p) => ({ ...p, transitionStyle: t }))
                    }
                    className={[
                      'py-3 px-4 rounded-xl border text-xs font-medium transition-all',
                      prefs.transitionStyle === t
                        ? 'bg-violet-500/20 border-violet-500 text-violet-300'
                        : 'bg-white/5 border-white/15 text-white/70 hover:border-white/30',
                    ].join(' ')}
                  >
                    {TRANSITION_LABELS[t]}
                  </button>
                ))}
              </div>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="step2"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <h3 className="text-white font-semibold text-sm mb-1">
                🎨 Choose overlays
              </h3>
              <p className="text-white/40 text-xs mb-4">
                Select which elements appear over your video.
              </p>
              <div className="space-y-3">
                {(
                  [
                    { key: 'showInterests', label: '✨ Interests wordcloud' },
                    { key: 'showActivity', label: '📊 Activity heatmap' },
                    { key: 'showLocation', label: '📍 Location pin' },
                    { key: 'showQuotes', label: '💬 Conversation highlights' },
                  ] as const
                ).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => toggleOverlay(key)}
                    className={[
                      'w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all',
                      prefs[key]
                        ? 'bg-violet-500/15 border-violet-500/50 text-white'
                        : 'bg-white/5 border-white/15 text-white/50',
                    ].join(' ')}
                  >
                    <span className="text-sm">{label}</span>
                    <div
                      className={[
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center',
                        prefs[key]
                          ? 'bg-violet-500 border-violet-500'
                          : 'border-white/30',
                      ].join(' ')}
                    >
                      {prefs[key] && (
                        <span className="text-white text-xs">✓</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer */}
      <div className="flex gap-3 px-5 pb-safe-bottom py-4 border-t border-white/10">
        {step > 0 && (
          <button
            onClick={() => setStep((s) => (s - 1) as 0 | 1 | 2)}
            className="flex-1 py-3 rounded-xl bg-white/10 text-white text-sm font-medium"
          >
            Back
          </button>
        )}
        <button
          onClick={() => {
            if (step < 2) {
              setStep((s) => (s + 1) as 0 | 1 | 2);
            } else {
              onComplete(prefs);
            }
          }}
          className="flex-1 py-3 rounded-xl bg-violet-500 text-white text-sm font-bold shadow-lg shadow-violet-500/30"
        >
          {step < 2 ? 'Next →' : '✨ Create Video'}
        </button>
      </div>
    </motion.div>
  );
}

// ─── VideoProfilePlayer ───────────────────────────────────────────────────────

/**
 * VideoProfilePlayer – renders a 15-second animated video dating profile.
 *
 * Behaviour:
 *   • Auto-plays on mount (muted by default).
 *   • Tap the mute/unmute button to hear background music.
 *   • Progress bar across the top tracks clip-by-clip progress.
 *   • View count increments once per mount (reported via `onView`).
 *   • "Create My Video" wizard can be opened via the floating button.
 *   • Overlays (wordcloud, heatmap, location, quotes) appear on a schedule
 *     driven by the profile data.
 */
export default function VideoProfilePlayer({
  profile,
  onLike,
  onSkip,
  onView,
  initialViewCount = 0,
  startInWizardMode = false,
  onWizardComplete,
  className = '',
}: VideoProfilePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );

  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(true);
  const [activeClipIndex, setActiveClipIndex] = useState(0);
  const [clipProgressFraction, setClipProgressFraction] = useState(0);
  const [viewCount, setViewCount] = useState(initialViewCount);
  const [showWizard, setShowWizard] = useState(startInWizardMode);
  const [showWordcloud, setShowWordcloud] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showLocation, setShowLocation] = useState(false);
  const [activeQuoteCard, setActiveQuoteCard] = useState<QuoteCard | null>(
    null,
  );

  // Stable ID for the audio element.
  const audioId = useId();

  const clips = profile.clips;
  const totalClips = clips.length;

  // ── View count ────────────────────────────────────────────────────────────

  useEffect(() => {
    setViewCount((c) => {
      const next = c + 1;
      onView?.(next);
      return next;
    });
    // Only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Clip timer ────────────────────────────────────────────────────────────

  const advanceClip = useCallback(() => {
    setActiveClipIndex((prev) => {
      const next = prev + 1;
      if (next >= totalClips) {
        // Loop back to start.
        setClipProgressFraction(0);
        return 0;
      }
      return next;
    });
    setClipProgressFraction(0);
  }, [totalClips]);

  useEffect(() => {
    if (!isPlaying) return;

    const clip = clips[activeClipIndex];
    const durationMs = (clip?.durationS ?? DEFAULT_CLIP_DURATION_S) * 1000;
    const tickMs = 50;
    let elapsed = 0;

    clearInterval(progressRef.current);

    progressRef.current = setInterval(() => {
      elapsed += tickMs;
      setClipProgressFraction(Math.min(elapsed / durationMs, 1));
      if (elapsed >= durationMs) {
        clearInterval(progressRef.current);
        advanceClip();
      }
    }, tickMs);

    return () => clearInterval(progressRef.current);
  }, [activeClipIndex, isPlaying, clips, advanceClip]);

  // ── Overlay schedule ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!isPlaying) return;

    const timers: ReturnType<typeof setTimeout>[] = [];

    // Wordcloud: show after 1 second.
    if (profile.interests && profile.interests.length > 0) {
      timers.push(setTimeout(() => setShowWordcloud(true), 1000));
      timers.push(setTimeout(() => setShowWordcloud(false), 4500));
    }

    // Activity heatmap: show after 5 seconds.
    if (profile.activityDays && profile.activityDays.length > 0) {
      timers.push(setTimeout(() => setShowHeatmap(true), 5000));
      timers.push(setTimeout(() => setShowHeatmap(false), 8500));
    }

    // Location: show after 9 seconds.
    if (profile.location) {
      timers.push(setTimeout(() => setShowLocation(true), 9000));
      timers.push(setTimeout(() => setShowLocation(false), 12000));
    }

    // Quote cards: schedule individually.
    if (profile.quoteCards) {
      for (const card of profile.quoteCards) {
        timers.push(
          setTimeout(() => setActiveQuoteCard(card), card.startAtS * 1000),
        );
      }
    }

    return () => {
      timers.forEach(clearTimeout);
      setShowWordcloud(false);
      setShowHeatmap(false);
      setShowLocation(false);
      setActiveQuoteCard(null);
    };
  }, [isPlaying, profile]);

  // ── Audio control ─────────────────────────────────────────────────────────

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = isMuted;
    if (!isMuted) {
      void audio.play().catch(() => {
        setIsMuted(true);
      });
    }
  }, [isMuted]);

  function handleToggleMute() {
    setIsMuted((m) => !m);
  }

  // ── Wizard completion ─────────────────────────────────────────────────────

  function handleWizardComplete(prefs: VideoWizardPreferences) {
    setShowWizard(false);
    onWizardComplete?.(prefs);
  }

  // ── Active clip ───────────────────────────────────────────────────────────

  const activeClip = clips[activeClipIndex];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className={[
        'relative w-full h-full bg-gray-950 overflow-hidden select-none',
        className,
      ].join(' ')}
      onClick={() => setIsPlaying((p) => !p)}
    >
      {/* Background photo / clip */}
      <AnimatePresence mode="sync">
        {activeClip && (
          <motion.div
            key={`clip-${activeClipIndex}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration:
                activeClip.transitionOut === 'crossfade' ||
                activeClip.transitionOut === 'morph'
                  ? 0.5
                  : 0.25,
            }}
            className="absolute inset-0"
          >
            {/* Render as background image (photo asset). */}
            <div
              className="absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: `url(${activeClip.sourceUrl})` }}
              role="img"
              aria-label={activeClip.altText ?? `Clip ${activeClipIndex + 1}`}
            />
            {/* Dark vignette overlay for readability. */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/60" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Clip progress bars */}
      <ClipProgress
        total={totalClips}
        activeIndex={activeClipIndex}
        progressFraction={clipProgressFraction}
      />

      {/* Pause indicator */}
      <AnimatePresence>
        {!isPlaying && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"
          >
            <div className="w-16 h-16 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center">
              <span className="text-white text-2xl">⏸</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* User name badge */}
      <UserNameBadge userName={profile.userName} age={profile.age} />

      {/* ── Overlays ── */}

      {/* Wordcloud burst */}
      <AnimatePresence>
        {showWordcloud && profile.interests && (
          <WordcloudOverlay key="wordcloud" words={profile.interests} />
        )}
      </AnimatePresence>

      {/* Activity heatmap */}
      <AnimatePresence>
        {showHeatmap && profile.activityDays && (
          <ActivityHeatmapOverlay
            key="heatmap"
            days={profile.activityDays}
            bannerText={profile.activityBannerText}
          />
        )}
      </AnimatePresence>

      {/* Location pin */}
      <AnimatePresence>
        {showLocation && profile.location && (
          <LocationPinOverlay key="location" label={profile.location} />
        )}
      </AnimatePresence>

      {/* Quote cards */}
      <AnimatePresence>
        {activeQuoteCard && (
          <QuoteCardOverlay key={`quote-${activeQuoteCard.index}`} card={activeQuoteCard} />
        )}
      </AnimatePresence>

      {/* Engagement bar (bottom) */}
      <EngagementBar
        viewCount={viewCount}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        onLike={onLike}
        onSkip={onSkip}
      />

      {/* "Create My Video" floating button */}
      {!showWizard && (
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={(e) => {
            e.stopPropagation();
            setShowWizard(true);
          }}
          className="absolute top-14 right-4 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-violet-500/90 border border-violet-400/60 shadow-lg shadow-violet-500/30 backdrop-blur-sm"
        >
          <span className="text-white text-xs font-bold">✨ Create Mine</span>
        </motion.button>
      )}

      {/* Background audio */}
      {profile.music && (
        <audio
          id={audioId}
          ref={audioRef}
          src={profile.music.url}
          loop
          muted={isMuted}
          preload="metadata"
        />
      )}

      {/* Create My Video wizard */}
      <AnimatePresence>
        {showWizard && (
          <CreateWizard
            key="wizard"
            onComplete={handleWizardComplete}
            onCancel={() => setShowWizard(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
