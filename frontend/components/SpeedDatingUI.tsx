'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The high-level screen shown inside SpeedDatingUI. */
export type SpeedDatingScreen =
  | 'queue'        // Waiting for a match
  | 'countdown'    // 10-second countdown before the call
  | 'call'         // Active 60-second speed date
  | 'voting'       // Post-call 10-second voting window
  | 'reveal'       // Dramatic result reveal
  | 'stats';       // Personal stats page

/** Selectable themes for Theme Night. */
export type SpeedDatingTheme =
  | 'travel'
  | 'music'
  | 'tech'
  | 'fitness'
  | 'food'
  | 'gaming'
  | null;

/** Result of post-call voting. */
export type VotingOutcome = 'mutual-match' | 'one-sided' | 'both-skipped' | null;

/** User statistics. */
export interface SpeedDatingStats {
  totalCalls: number;
  mutualMatches: number;
  heartsGiven: number;
  heartsReceived: number;
  matchRate: number;
}

export interface SpeedDatingUIProps {
  /** Remote user's display name. */
  remoteName?: string;
  /** Remote user age (for display only). */
  remoteAge?: number;
  /** Remote MediaStream (WebRTC). */
  remoteStream?: MediaStream | null;
  /** Local MediaStream for self-view PiP. */
  localStream?: MediaStream | null;
  /** Which screen is currently visible. Controlled externally. */
  screen?: SpeedDatingScreen;
  /** Seconds remaining in the countdown (0–10). */
  countdownSeconds?: number;
  /** Seconds remaining in the call (0–60). */
  callSecondsRemaining?: number;
  /** Seconds remaining in the voting window (0–10). */
  votingSecondsRemaining?: number;
  /** Result of the voting phase – available on reveal screen. */
  votingOutcome?: VotingOutcome;
  /** True when the other user liked the local user (for FOMO reveal). */
  theyLikedYou?: boolean;
  /** Estimated queue wait time in seconds. */
  estimatedWaitSeconds?: number;
  /** Currently selected theme. */
  selectedTheme?: SpeedDatingTheme;
  /** Stats for the stats page. */
  stats?: SpeedDatingStats;
  /** Whether Happy Hour is currently active. */
  happyHourActive?: boolean;
  /** Theme Night label (e.g. "🎵 Music Night"). Null when inactive. */
  themeNightLabel?: string | null;
  // ── Callbacks ──────────────────────────────────────────────────────────────
  onJoinQueue?: (theme: SpeedDatingTheme) => void;
  onLeaveQueue?: () => void;
  onCancelCountdown?: () => void;
  onEndCall?: () => void;
  onCastVote?: (vote: 'heart' | 'next') => void;
  onOpenStats?: () => void;
  onCloseStats?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CALL_DURATION_S = 60;
const VOTING_DURATION_S = 10;
const COUNTDOWN_DURATION_S = 10;

const THEMES: { value: SpeedDatingTheme; label: string; emoji: string }[] = [
  { value: null,      label: 'Any',     emoji: '🌍' },
  { value: 'travel',  label: 'Travel',  emoji: '✈️' },
  { value: 'music',   label: 'Music',   emoji: '🎵' },
  { value: 'tech',    label: 'Tech',    emoji: '💻' },
  { value: 'fitness', label: 'Fitness', emoji: '🏃' },
  { value: 'food',    label: 'Food',    emoji: '🍕' },
  { value: 'gaming',  label: 'Gaming',  emoji: '🎮' }
];

/** Format seconds as M:SS. */
function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** SVG circular progress ring. radius = 44, stroke = 8. */
function ProgressRing({
  value,
  max,
  size = 120,
  strokeWidth = 8,
  color = '#ec4899',
  warningColor = '#ef4444',
  warn = false
}: {
  value: number;
  max: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  warningColor?: string;
  warn?: boolean;
}) {
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const progress = Math.max(0, Math.min(1, value / max));
  const dashOffset = circumference * (1 - progress);
  const activeColor = warn ? warningColor : color;

  return (
    <svg width={size} height={size} className="-rotate-90">
      {/* Track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.15)"
        strokeWidth={strokeWidth}
      />
      {/* Progress */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={activeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        style={{ transition: 'stroke-dashoffset 0.8s linear, stroke 0.3s ease' }}
      />
    </svg>
  );
}

// ─── VideoElement ─────────────────────────────────────────────────────────────

function VideoElement({
  stream,
  muted,
  className
}: {
  stream: MediaStream | null | undefined;
  muted?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <video ref={ref} autoPlay playsInline muted={muted} className={className} />
  );
}

// ─── SelfViewPiP ─────────────────────────────────────────────────────────────

function SelfViewPiP({ localStream }: { localStream?: MediaStream | null }) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    isDragging.current = true;
    dragStart.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDragging.current) return;
    setPos({
      x: dragStart.current.px + (e.clientX - dragStart.current.mx),
      y: dragStart.current.py + (e.clientY - dragStart.current.my)
    });
  }

  function onPointerUp() {
    isDragging.current = false;
  }

  return (
    <div
      className="absolute bottom-32 right-4 z-30 w-24 h-36 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl bg-gray-900 cursor-grab active:cursor-grabbing"
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {localStream ? (
        <VideoElement stream={localStream} muted className="w-full h-full object-cover scale-x-[-1]" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-white/30 text-3xl">📷</div>
      )}
    </div>
  );
}

// ─── Confetti ─────────────────────────────────────────────────────────────────

const CONFETTI_PIECES = Array.from({ length: 32 }, (_, i) => ({
  id: i,
  x: Math.random() * 100,
  delay: Math.random() * 0.8,
  duration: 1.2 + Math.random() * 1.2,
  color: ['#ec4899', '#a855f7', '#3b82f6', '#10b981', '#f59e0b', '#ef4444'][i % 6]!,
  size: 8 + Math.random() * 8
}));

function Confetti() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden z-50">
      {CONFETTI_PIECES.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-sm"
          style={{
            left: `${p.x}%`,
            top: '-10px',
            width: p.size,
            height: p.size * 0.6,
            backgroundColor: p.color
          }}
          initial={{ y: 0, opacity: 1, rotate: 0 }}
          animate={{ y: '110vh', opacity: [1, 1, 0], rotate: 720 }}
          transition={{ delay: p.delay, duration: p.duration, ease: 'easeIn' }}
        />
      ))}
    </div>
  );
}

// ─── QueueScreen ──────────────────────────────────────────────────────────────

interface QueueScreenProps {
  estimatedWaitSeconds?: number;
  selectedTheme: SpeedDatingTheme;
  happyHourActive?: boolean;
  themeNightLabel?: string | null;
  onThemeChange: (theme: SpeedDatingTheme) => void;
  onJoin: () => void;
  onOpenStats?: () => void;
}

function QueueScreen({
  estimatedWaitSeconds,
  selectedTheme,
  happyHourActive,
  themeNightLabel,
  onThemeChange,
  onJoin,
  onOpenStats
}: QueueScreenProps) {
  return (
    <div className="relative flex flex-col items-center justify-center h-full bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 px-6 gap-8">
      {/* Stats button */}
      <button
        onClick={onOpenStats}
        className="absolute top-5 right-5 p-2.5 rounded-full bg-white/10 text-white text-xl hover:bg-white/20 transition"
        aria-label="Open stats"
      >
        📊
      </button>

      {/* Header */}
      <div className="text-center">
        <h1 className="text-4xl font-bold text-white mb-1">Speed Dating</h1>
        <p className="text-white/50 text-sm">60-second video calls. No pressure.</p>
      </div>

      {/* Happy Hour / Theme Night banners */}
      <AnimatePresence>
        {happyHourActive && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 text-sm font-semibold"
          >
            ⚡ Happy Hour — 2× match rate until 10 PM
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {themeNightLabel && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-purple-500/20 border border-purple-500/40 text-purple-300 text-sm font-semibold"
          >
            🎭 {themeNightLabel}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Theme selector */}
      <div className="w-full max-w-xs">
        <p className="text-white/50 text-xs uppercase tracking-widest mb-3 text-center">
          Choose a theme
        </p>
        <div className="grid grid-cols-4 gap-2">
          {THEMES.map((t) => (
            <button
              key={String(t.value)}
              onClick={() => onThemeChange(t.value)}
              className={[
                'flex flex-col items-center gap-1 p-2.5 rounded-2xl border text-xs transition-all',
                selectedTheme === t.value
                  ? 'bg-pink-500/20 border-pink-500 text-pink-300 scale-105'
                  : 'bg-white/5 border-white/10 text-white/50 hover:bg-white/10'
              ].join(' ')}
            >
              <span className="text-xl">{t.emoji}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Join button */}
      <div className="flex flex-col items-center gap-3">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onJoin}
          className="px-10 py-4 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 text-white font-bold text-lg shadow-2xl shadow-pink-500/30 border border-white/10"
        >
          Find Someone ✨
        </motion.button>

        {estimatedWaitSeconds !== undefined && (
          <p className="text-white/40 text-xs">
            ~{estimatedWaitSeconds < 60
              ? `${estimatedWaitSeconds}s`
              : `${Math.round(estimatedWaitSeconds / 60)}m`} wait
          </p>
        )}
      </div>

      {/* How it works */}
      <div className="w-full max-w-xs rounded-2xl bg-white/5 border border-white/10 p-4 text-center">
        <p className="text-white/70 text-xs leading-relaxed">
          You have <span className="text-white font-semibold">60 seconds</span> to vibe.
          After the call, swipe <span className="text-pink-400">💗 Heart</span> or{' '}
          <span className="text-white/50">👋 Next</span>. Match to chat!
        </p>
      </div>
    </div>
  );
}

// ─── WaitingScreen (in-queue) ─────────────────────────────────────────────────

interface WaitingScreenProps {
  estimatedWaitSeconds?: number;
  selectedTheme: SpeedDatingTheme;
  happyHourActive?: boolean;
  onLeave: () => void;
}

function WaitingScreen({
  estimatedWaitSeconds,
  selectedTheme,
  happyHourActive,
  onLeave
}: WaitingScreenProps) {
  const theme = THEMES.find((t) => t.value === selectedTheme) ?? THEMES[0]!;

  return (
    <div className="relative flex flex-col items-center justify-center h-full bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 gap-8 px-6">
      {/* Pulsing indicator */}
      <div className="relative flex items-center justify-center">
        {[1, 2, 3].map((i) => (
          <motion.div
            key={i}
            className="absolute rounded-full border border-pink-500/40"
            style={{ width: 60 + i * 40, height: 60 + i * 40 }}
            animate={{ scale: [1, 1.08, 1], opacity: [0.4, 0.1, 0.4] }}
            transition={{ duration: 2, delay: i * 0.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        ))}
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center text-2xl shadow-xl shadow-pink-500/30">
          {theme.emoji}
        </div>
      </div>

      <div className="text-center">
        <p className="text-white font-bold text-xl mb-1">Finding someone…</p>
        {estimatedWaitSeconds !== undefined && (
          <p className="text-white/40 text-sm">
            Est. wait:{' '}
            {estimatedWaitSeconds < 60
              ? `${estimatedWaitSeconds}s`
              : `${Math.round(estimatedWaitSeconds / 60)}m`}
          </p>
        )}
      </div>

      {happyHourActive && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 text-sm font-semibold">
          ⚡ Happy Hour — higher match rate active
        </div>
      )}

      <button
        onClick={onLeave}
        className="px-8 py-3 rounded-full bg-white/10 border border-white/10 text-white/60 text-sm hover:bg-white/20 transition"
      >
        Leave Queue
      </button>
    </div>
  );
}

// ─── CountdownScreen ──────────────────────────────────────────────────────────

interface CountdownScreenProps {
  secondsRemaining: number;
  remoteName: string;
  onCancel: () => void;
}

function CountdownScreen({ secondsRemaining, remoteName, onCancel }: CountdownScreenProps) {
  const canCancel = secondsRemaining > COUNTDOWN_DURATION_S - 5;

  return (
    <div className="relative flex flex-col items-center justify-center h-full bg-gradient-to-b from-gray-950 to-gray-900 gap-8">
      <p className="text-white/60 text-base">Get ready to meet</p>
      <p className="text-white font-bold text-3xl">{remoteName}</p>

      {/* Big countdown number */}
      <AnimatePresence mode="wait">
        <motion.div
          key={secondsRemaining}
          initial={{ scale: 1.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.7, opacity: 0 }}
          transition={{ duration: 0.35 }}
          className="text-8xl font-bold text-white tabular-nums"
          style={{ textShadow: '0 0 40px rgba(236,72,153,0.6)' }}
        >
          {secondsRemaining}
        </motion.div>
      </AnimatePresence>

      <p className="text-white/40 text-sm">Starting soon…</p>

      {canCancel && (
        <button
          onClick={onCancel}
          className="px-7 py-2.5 rounded-full bg-white/10 border border-white/10 text-white/60 text-sm hover:bg-white/20 transition"
        >
          Cancel (free)
        </button>
      )}
    </div>
  );
}

// ─── CallScreen ───────────────────────────────────────────────────────────────

interface CallScreenProps {
  secondsRemaining: number;
  remoteName: string;
  remoteStream?: MediaStream | null;
  localStream?: MediaStream | null;
  onEndCall: () => void;
}

function CallScreen({
  secondsRemaining,
  remoteName,
  remoteStream,
  localStream,
  onEndCall
}: CallScreenProps) {
  const [showControls, setShowControls] = useState(true);
  const controlsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const warn = secondsRemaining <= 10;

  const resetControls = useCallback(() => {
    setShowControls(true);
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setShowControls(false), 4000);
  }, []);

  useEffect(() => {
    resetControls();
    return () => clearTimeout(controlsTimer.current);
  }, [resetControls]);

  return (
    <div
      className="relative w-full h-full bg-black overflow-hidden"
      onClick={resetControls}
      onPointerMove={resetControls}
    >
      {/* Warning flash overlay */}
      <AnimatePresence>
        {warn && (
          <motion.div
            key="warn-flash"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.25, 0] }}
            transition={{ duration: 0.6, repeat: Infinity }}
            className="absolute inset-0 z-40 pointer-events-none bg-red-500"
          />
        )}
      </AnimatePresence>

      {/* Remote video */}
      {remoteStream ? (
        <VideoElement
          stream={remoteStream}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          <div className="text-6xl animate-pulse">📡</div>
          <p className="text-white/60 text-lg">Connecting to {remoteName}…</p>
        </div>
      )}

      {/* Floating countdown ring – always visible */}
      <div className="absolute top-5 left-1/2 -translate-x-1/2 z-30 flex items-center justify-center">
        <ProgressRing
          value={secondsRemaining}
          max={CALL_DURATION_S}
          size={80}
          strokeWidth={6}
          warn={warn}
        />
        <div className="absolute flex flex-col items-center">
          <span
            className={['text-xl font-bold tabular-nums', warn ? 'text-red-400' : 'text-white'].join(' ')}
          >
            {secondsRemaining}
          </span>
          <span className="text-white/40 text-[9px]">sec</span>
        </div>
      </div>

      {/* Name tag */}
      <AnimatePresence>
        {showControls && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute top-5 left-5 z-20 px-3 py-1 rounded-full bg-black/50 backdrop-blur-sm text-white text-sm font-semibold"
          >
            {remoteName}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Self view */}
      <SelfViewPiP localStream={localStream} />

      {/* End call button */}
      <AnimatePresence>
        {showControls && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-0 inset-x-0 z-20 flex items-center justify-center pb-safe-bottom py-6 bg-gradient-to-t from-black/70 to-transparent"
          >
            <motion.button
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              onClick={onEndCall}
              className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-xl text-2xl border-2 border-red-400"
              aria-label="End call"
            >
              📵
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── VotingScreen ─────────────────────────────────────────────────────────────

interface VotingScreenProps {
  secondsRemaining: number;
  remoteName: string;
  onVote: (vote: 'heart' | 'next') => void;
  myVote: 'heart' | 'next' | null;
}

function VotingScreen({ secondsRemaining, remoteName, onVote, myVote }: VotingScreenProps) {
  return (
    <div className="relative flex flex-col items-center justify-center h-full bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 gap-8 px-6">
      <div className="text-center">
        <p className="text-white/50 text-sm mb-1">Your call with {remoteName} ended</p>
        <p className="text-white font-bold text-2xl">How did it go?</p>
      </div>

      {/* Voting timer ring */}
      <div className="relative flex items-center justify-center">
        <ProgressRing
          value={secondsRemaining}
          max={VOTING_DURATION_S}
          size={100}
          strokeWidth={7}
          color="#a855f7"
          warn={secondsRemaining <= 3}
          warningColor="#ef4444"
        />
        <div className="absolute flex flex-col items-center">
          <span className="text-2xl font-bold text-white tabular-nums">{secondsRemaining}</span>
          <span className="text-white/40 text-[9px]">sec left</span>
        </div>
      </div>

      {/* Vote buttons */}
      <div className="flex gap-6">
        {/* Heart */}
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.88 }}
          onClick={() => onVote('heart')}
          disabled={myVote !== null}
          className={[
            'flex flex-col items-center gap-2 w-32 py-5 rounded-3xl border-2 transition-all',
            myVote === 'heart'
              ? 'bg-pink-500/20 border-pink-500 shadow-xl shadow-pink-500/30'
              : myVote === 'next'
              ? 'opacity-40 bg-white/5 border-white/10'
              : 'bg-white/5 border-white/20 hover:bg-pink-500/10 hover:border-pink-500/60'
          ].join(' ')}
          aria-label="Heart – I liked them"
        >
          <span className="text-4xl">💗</span>
          <span className="text-white font-semibold text-sm">Heart</span>
        </motion.button>

        {/* Next */}
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.88 }}
          onClick={() => onVote('next')}
          disabled={myVote !== null}
          className={[
            'flex flex-col items-center gap-2 w-32 py-5 rounded-3xl border-2 transition-all',
            myVote === 'next'
              ? 'bg-white/15 border-white/40 shadow-xl'
              : myVote === 'heart'
              ? 'opacity-40 bg-white/5 border-white/10'
              : 'bg-white/5 border-white/20 hover:bg-white/10 hover:border-white/30'
          ].join(' ')}
          aria-label="Next – move on"
        >
          <span className="text-4xl">👋</span>
          <span className="text-white/70 font-semibold text-sm">Next</span>
        </motion.button>
      </div>

      {myVote && (
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-white/50 text-sm"
        >
          {myVote === 'heart' ? 'Waiting to see if they liked you…' : 'Moving on…'}
        </motion.p>
      )}
    </div>
  );
}

// ─── RevealScreen ─────────────────────────────────────────────────────────────

interface RevealScreenProps {
  outcome: VotingOutcome;
  theyLikedYou: boolean;
  remoteName: string;
  onFindNext: () => void;
  onOpenChat?: () => void;
}

function RevealScreen({ outcome, theyLikedYou, remoteName, onFindNext, onOpenChat }: RevealScreenProps) {
  const isMutual = outcome === 'mutual-match';
  const isFomo = outcome === 'one-sided' && theyLikedYou;

  return (
    <div className="relative flex flex-col items-center justify-center h-full bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 gap-6 px-6 overflow-hidden">
      {isMutual && <Confetti />}

      {/* Card */}
      <motion.div
        initial={{ scale: 0.7, opacity: 0, rotateY: -25 }}
        animate={{ scale: 1, opacity: 1, rotateY: 0 }}
        transition={{ type: 'spring', stiffness: 160, damping: 18 }}
        className={[
          'w-full max-w-xs rounded-3xl border p-8 flex flex-col items-center gap-4 shadow-2xl',
          isMutual
            ? 'bg-gradient-to-b from-pink-950/60 to-purple-950/60 border-pink-500/40'
            : isFomo
            ? 'bg-gradient-to-b from-amber-950/60 to-orange-950/60 border-amber-500/40'
            : 'bg-white/5 border-white/10'
        ].join(' ')}
      >
        <span className="text-7xl">
          {isMutual ? '🎉' : isFomo ? '💘' : '💪'}
        </span>

        <p className={[
          'text-2xl font-bold text-center',
          isMutual ? 'text-pink-300' : isFomo ? 'text-amber-300' : 'text-white'
        ].join(' ')}>
          {isMutual
            ? "It's a match!"
            : isFomo
            ? `${remoteName} liked you!`
            : 'Keep going!'}
        </p>

        <p className="text-white/50 text-sm text-center">
          {isMutual
            ? 'You both liked each other 💗 Chat is now open!'
            : isFomo
            ? "They liked you back — don't let them slip away 👀"
            : 'There are plenty of people waiting to meet you.'}
        </p>
      </motion.div>

      {/* Action buttons */}
      <div className="flex flex-col gap-3 w-full max-w-xs">
        {isMutual && onOpenChat && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={onOpenChat}
            className="py-4 rounded-2xl bg-gradient-to-r from-pink-500 to-purple-600 text-white font-bold text-base shadow-lg shadow-pink-500/30 border border-white/10"
          >
            Open Chat 💬
          </motion.button>
        )}

        <motion.button
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: isMutual ? 0.6 : 0.3 }}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={onFindNext}
          className="py-4 rounded-2xl bg-white/10 border border-white/10 text-white font-semibold text-base hover:bg-white/15 transition"
        >
          {isMutual ? 'Keep Meeting People' : 'Find Next Person ✨'}
        </motion.button>
      </div>
    </div>
  );
}

// ─── StatsScreen ─────────────────────────────────────────────────────────────

interface StatsScreenProps {
  stats: SpeedDatingStats;
  onClose: () => void;
}

function StatsScreen({ stats, onClose }: StatsScreenProps) {
  const matchRateColor =
    stats.matchRate >= 50
      ? 'text-green-400'
      : stats.matchRate >= 25
      ? 'text-amber-400'
      : 'text-white/60';

  return (
    <div className="flex flex-col h-full bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-safe-top py-4 border-b border-white/10">
        <h2 className="text-white font-bold text-xl">Your Stats</h2>
        <button
          onClick={onClose}
          className="p-2 rounded-full bg-white/10 text-white/70 hover:bg-white/20 transition"
          aria-label="Close stats"
        >
          ✕
        </button>
      </div>

      {/* Stats grid */}
      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
        {/* Match Rate Hero */}
        <div className="rounded-3xl bg-white/5 border border-white/10 p-6 flex flex-col items-center gap-2">
          <p className="text-white/50 text-xs uppercase tracking-widest">Match Rate</p>
          <p className={`text-6xl font-bold tabular-nums ${matchRateColor}`}>
            {stats.matchRate.toFixed(0)}%
          </p>
          <p className="text-white/30 text-xs">
            {stats.mutualMatches} match{stats.mutualMatches !== 1 ? 'es' : ''} from {stats.totalCalls} call{stats.totalCalls !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Total Calls', value: stats.totalCalls, emoji: '📞' },
            { label: 'Matches Today', value: stats.mutualMatches, emoji: '💗' },
            { label: 'Hearts Given', value: stats.heartsGiven, emoji: '💖' },
            { label: 'Hearts Received', value: stats.heartsReceived, emoji: '🫀' }
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-2xl bg-white/5 border border-white/10 p-4 flex flex-col gap-1"
            >
              <span className="text-2xl">{item.emoji}</span>
              <p className="text-white font-bold text-2xl tabular-nums">{item.value}</p>
              <p className="text-white/40 text-xs">{item.label}</p>
            </div>
          ))}
        </div>

        {/* Motivation footer */}
        <div className="rounded-2xl bg-gradient-to-r from-pink-500/10 to-purple-500/10 border border-pink-500/20 p-4 text-center">
          <p className="text-white/70 text-sm">
            {stats.totalCalls === 0
              ? 'Start your first speed date! 🚀'
              : stats.matchRate >= 50
              ? "You're a natural! Keep it up 🔥"
              : stats.mutualMatches === 0
              ? 'One great call can change everything 💫'
              : 'Every call is a chance to connect ✨'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── SpeedDatingUI ────────────────────────────────────────────────────────────

/**
 * SpeedDatingUI – top-level orchestration component for the Speed Dating
 * mini-game.
 *
 * All timing and state are controlled by the parent (or a custom hook that
 * wraps SpeedDatingQueue / SpeedCallManager / PostCallVoting).  This component
 * is purely presentational.
 */
export default function SpeedDatingUI({
  remoteName = 'Someone',
  remoteAge,
  remoteStream,
  localStream,
  screen = 'queue',
  countdownSeconds = COUNTDOWN_DURATION_S,
  callSecondsRemaining = CALL_DURATION_S,
  votingSecondsRemaining = VOTING_DURATION_S,
  votingOutcome = null,
  theyLikedYou = false,
  estimatedWaitSeconds,
  selectedTheme: externalTheme,
  stats = { totalCalls: 0, mutualMatches: 0, heartsGiven: 0, heartsReceived: 0, matchRate: 0 },
  happyHourActive = false,
  themeNightLabel = null,
  onJoinQueue,
  onLeaveQueue,
  onCancelCountdown,
  onEndCall,
  onCastVote,
  onOpenStats,
  onCloseStats
}: SpeedDatingUIProps) {
  // Internal theme selection (can be lifted to parent via onJoinQueue arg).
  const [internalTheme, setInternalTheme] = useState<SpeedDatingTheme>(null);
  const selectedTheme = externalTheme !== undefined ? externalTheme : internalTheme;

  // My current vote (local optimistic state).
  const [myVote, setMyVote] = useState<'heart' | 'next' | null>(null);

  // Reset my vote whenever we enter voting screen.
  useEffect(() => {
    if (screen === 'voting') setMyVote(null);
  }, [screen]);

  function handleVote(vote: 'heart' | 'next') {
    if (myVote !== null) return;
    setMyVote(vote);
    onCastVote?.(vote);
  }

  const displayName = remoteAge ? `${remoteName}, ${remoteAge}` : remoteName;

  return (
    <div className="w-full h-full bg-gray-950 overflow-hidden">
      <AnimatePresence mode="wait">
        {/* Queue / pre-join screen */}
        {screen === 'queue' && (
          <motion.div
            key="queue"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full h-full"
          >
            <QueueScreen
              estimatedWaitSeconds={estimatedWaitSeconds}
              selectedTheme={selectedTheme}
              happyHourActive={happyHourActive}
              themeNightLabel={themeNightLabel}
              onThemeChange={setInternalTheme}
              onJoin={() => onJoinQueue?.(selectedTheme)}
              onOpenStats={onOpenStats}
            />
          </motion.div>
        )}

        {/* Waiting-in-queue screen */}
        {(screen as string) === 'waiting' && (
          <motion.div
            key="waiting"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full h-full"
          >
            <WaitingScreen
              estimatedWaitSeconds={estimatedWaitSeconds}
              selectedTheme={selectedTheme}
              happyHourActive={happyHourActive}
              onLeave={() => onLeaveQueue?.()}
            />
          </motion.div>
        )}

        {/* 10-second countdown */}
        {screen === 'countdown' && (
          <motion.div
            key="countdown"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="w-full h-full"
          >
            <CountdownScreen
              secondsRemaining={countdownSeconds}
              remoteName={displayName}
              onCancel={() => onCancelCountdown?.()}
            />
          </motion.div>
        )}

        {/* Active call */}
        {screen === 'call' && (
          <motion.div
            key="call"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full h-full"
          >
            <CallScreen
              secondsRemaining={callSecondsRemaining}
              remoteName={displayName}
              remoteStream={remoteStream}
              localStream={localStream}
              onEndCall={() => onEndCall?.()}
            />
          </motion.div>
        )}

        {/* Post-call voting */}
        {screen === 'voting' && (
          <motion.div
            key="voting"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="w-full h-full"
          >
            <VotingScreen
              secondsRemaining={votingSecondsRemaining}
              remoteName={displayName}
              onVote={handleVote}
              myVote={myVote}
            />
          </motion.div>
        )}

        {/* Dramatic reveal */}
        {screen === 'reveal' && (
          <motion.div
            key="reveal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full h-full"
          >
            <RevealScreen
              outcome={votingOutcome}
              theyLikedYou={theyLikedYou}
              remoteName={displayName}
              onFindNext={() => onJoinQueue?.(selectedTheme)}
            />
          </motion.div>
        )}

        {/* Stats */}
        {screen === 'stats' && (
          <motion.div
            key="stats"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="w-full h-full"
          >
            <StatsScreen stats={stats} onClose={() => onCloseStats?.()} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
