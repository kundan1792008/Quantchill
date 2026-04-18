'use client';

/**
 * SpeedDatingUI – the four-screen flow for Quantchill's 60-second speed-dating
 * roulette (issue #25 §4).
 *
 * Screens:
 *  1. QueueScreen     – pulsing "Finding someone…" with estimated wait.
 *  2. CountdownScreen – 10-second pre-call countdown with free-cancel + accept.
 *  3. CallScreen      – full-screen video with floating 60-s countdown ring,
 *                       10-s warning flash, quality indicator, end-call btn.
 *  4. PostCallScreen  – dramatic card reveal: mutual match, one-sided, or skip.
 *  5. StatsScreen     – matches today, total calls, match-rate percentage.
 *
 * The component is fully controlled: the parent page owns the network layer
 * (WebSocket to the signaling server) and pushes state in through props.
 * Internal state is limited to UI concerns (animations, elapsed timers).
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SpeedDatingPhase =
  | 'idle'
  | 'queued'
  | 'countdown'
  | 'in-call'
  | 'voting'
  | 'post-call'
  | 'stats';

export type ConnectionQuality = 'good' | 'medium' | 'poor' | 'disconnected';

export type PostCallOutcome =
  | { kind: 'mutual-match'; chatRoomId: string; partnerName: string }
  | { kind: 'they-liked-you'; partnerName: string }
  | { kind: 'you-liked-them'; partnerName: string }
  | { kind: 'no-match'; partnerName: string }
  | { kind: 'no-votes'; partnerName: string };

export interface DailyStats {
  matchesToday: number;
  totalCalls: number;
  /** 0-100. */
  matchRatePercent: number;
  /** Longest streak of mutual matches in a row today. */
  bestStreak: number;
}

export interface SpeedDatingUIProps {
  phase: SpeedDatingPhase;
  /** Estimated ms until a partner is found. */
  estimatedWaitMs?: number;
  /** Number of people currently in the global queue. */
  queueDepth?: number;
  /** Remaining ms in the pre-call countdown (phase=countdown). */
  countdownRemainingMs?: number;
  /** Whether the user can still cancel without penalty. */
  inFreeCancelWindow?: boolean;
  /** Partner display name for the current match. */
  partnerName?: string;
  /** Partner age. */
  partnerAge?: number;
  /** Remote MediaStream (WebRTC, phase=in-call). */
  remoteStream?: MediaStream | null;
  /** Local MediaStream for PiP self-view. */
  localStream?: MediaStream | null;
  /** Remaining ms in the 60-second call. */
  callRemainingMs?: number;
  /** Connection quality indicator. */
  connectionQuality?: ConnectionQuality;
  /** Remaining ms in the 10-second voting window. */
  voteRemainingMs?: number;
  /** Outcome to display on the post-call screen. */
  postCallOutcome?: PostCallOutcome;
  /** Stats for the StatsScreen. */
  stats?: DailyStats;
  /** True while a happy-hour event is active. */
  happyHourActive?: boolean;
  /** If set, displays "Theme: <theme>" on the queue screen. */
  themeNight?: string;
  /** Callback invoked when the user joins / leaves / votes / etc. */
  onJoin?: () => void;
  onLeave?: () => void;
  onAccept?: () => void;
  onCancel?: () => void;
  onHangup?: () => void;
  onVote?: (choice: 'heart' | 'skip') => void;
  onOpenStats?: () => void;
  onCloseStats?: () => void;
  onStartChat?: (chatRoomId: string) => void;
  onRequeue?: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CALL_DURATION_MS = 60_000;
const COUNTDOWN_DURATION_MS = 10_000;
const VOTING_WINDOW_MS = 10_000;

const QUALITY_COLORS: Record<ConnectionQuality, string> = {
  good: '#4ade80',
  medium: '#facc15',
  poor: '#f97316',
  disconnected: '#ef4444'
};

const QUALITY_LABELS: Record<ConnectionQuality, string> = {
  good: 'Good',
  medium: 'Fair',
  poor: 'Poor',
  disconnected: 'Lost'
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function formatSeconds(ms: number): string {
  return Math.max(0, Math.ceil(ms / 1000)).toString();
}

function formatWait(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

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
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

/** Circular countdown ring drawn with a single SVG stroke. */
function CountdownRing({
  progress,
  size = 120,
  stroke = 6,
  color = '#22d3ee',
  warning = false
}: {
  /** 0-1, where 1 = full ring. */
  progress: number;
  size?: number;
  stroke?: number;
  color?: string;
  warning?: boolean;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * clampPct(progress * 100) / 100;
  return (
    <svg width={size} height={size} className={warning ? 'animate-pulse' : ''}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.15)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={warning ? '#ef4444' : color}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${c - dash}`}
        strokeDashoffset={c / 4}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.2s linear' }}
      />
    </svg>
  );
}

// ─── Screen: Queue ───────────────────────────────────────────────────────────

function QueueScreen({
  estimatedWaitMs = 0,
  queueDepth = 0,
  happyHourActive,
  themeNight,
  onLeave,
  onOpenStats
}: Pick<
  SpeedDatingUIProps,
  'estimatedWaitMs' | 'queueDepth' | 'happyHourActive' | 'themeNight' | 'onLeave' | 'onOpenStats'
>) {
  const pulse = useMemo(
    () => ({
      animate: { scale: [1, 1.04, 1], opacity: [0.8, 1, 0.8] },
      transition: { repeat: Infinity, duration: 1.6, ease: 'easeInOut' as const }
    }),
    []
  );
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center bg-gradient-to-b from-indigo-900 via-fuchsia-900 to-black text-white">
      {happyHourActive && (
        <motion.div
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="absolute top-6 px-4 py-1.5 rounded-full bg-pink-500/80 text-sm font-semibold shadow-xl"
        >
          ✨ Happy Hour — 2× match rate
        </motion.div>
      )}
      {themeNight && (
        <div className="absolute top-20 text-xs uppercase tracking-widest text-white/70">
          Theme: {themeNight}
        </div>
      )}

      <motion.div {...pulse} className="relative mb-10">
        <div className="w-48 h-48 rounded-full bg-gradient-to-br from-pink-500 to-violet-500 shadow-[0_0_120px_rgba(244,114,182,0.5)]" />
        <div className="absolute inset-0 flex items-center justify-center text-5xl">💫</div>
      </motion.div>

      <h1 className="text-3xl font-bold mb-2">Finding someone…</h1>
      <p className="text-white/60">
        {queueDepth > 0 ? `${queueDepth} people online • ` : ''}~{formatWait(estimatedWaitMs)}
      </p>

      <div className="absolute bottom-10 inset-x-0 flex items-center justify-center gap-3">
        <button
          onClick={onLeave}
          className="px-5 py-2 rounded-full bg-white/10 hover:bg-white/20 text-sm backdrop-blur-sm"
        >
          Leave queue
        </button>
        <button
          onClick={onOpenStats}
          className="px-5 py-2 rounded-full bg-white/10 hover:bg-white/20 text-sm backdrop-blur-sm"
        >
          📊 Stats
        </button>
      </div>
    </div>
  );
}

// ─── Screen: Countdown ───────────────────────────────────────────────────────

function CountdownScreen({
  partnerName = 'Someone',
  partnerAge,
  countdownRemainingMs = 0,
  inFreeCancelWindow,
  onAccept,
  onCancel
}: Pick<
  SpeedDatingUIProps,
  'partnerName' | 'partnerAge' | 'countdownRemainingMs' | 'inFreeCancelWindow' | 'onAccept' | 'onCancel'
>) {
  const progress = countdownRemainingMs / COUNTDOWN_DURATION_MS;
  const seconds = formatSeconds(countdownRemainingMs);
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-slate-900 to-indigo-950 text-white">
      <p className="text-white/60 mb-3 uppercase tracking-widest text-xs">Match found</p>
      <h2 className="text-4xl font-bold mb-1">{partnerName}</h2>
      {typeof partnerAge === 'number' && <p className="text-white/50 mb-10">{partnerAge} years old</p>}

      <div className="relative mb-10">
        <CountdownRing progress={progress} size={160} stroke={8} color="#22d3ee" />
        <div className="absolute inset-0 flex items-center justify-center text-5xl font-mono">{seconds}</div>
      </div>

      <div className="flex gap-4">
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={onCancel}
          className={[
            'px-6 py-3 rounded-full font-semibold',
            inFreeCancelWindow ? 'bg-white/10 hover:bg-white/20' : 'bg-red-500/80 hover:bg-red-500'
          ].join(' ')}
        >
          {inFreeCancelWindow ? 'Cancel' : 'Cancel (penalty)'}
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={onAccept}
          className="px-6 py-3 rounded-full bg-gradient-to-r from-pink-500 to-violet-500 font-semibold shadow-xl"
        >
          I&apos;m ready →
        </motion.button>
      </div>
    </div>
  );
}

// ─── Screen: Call ────────────────────────────────────────────────────────────

function SelfViewPiP({ localStream }: { localStream?: MediaStream | null }) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const start = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    isDragging.current = true;
    start.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDragging.current) return;
    setPos({
      x: start.current.px + (e.clientX - start.current.mx),
      y: start.current.py + (e.clientY - start.current.my)
    });
  }
  function onPointerUp() { isDragging.current = false; }

  return (
    <div
      className="absolute bottom-24 right-4 z-30 w-28 h-40 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl bg-gray-900 cursor-grab active:cursor-grabbing"
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

function CallScreen({
  partnerName = 'Partner',
  remoteStream,
  localStream,
  callRemainingMs = CALL_DURATION_MS,
  connectionQuality = 'good',
  onHangup
}: Pick<
  SpeedDatingUIProps,
  'partnerName' | 'remoteStream' | 'localStream' | 'callRemainingMs' | 'connectionQuality' | 'onHangup'
>) {
  const warning = callRemainingMs <= 10_000;
  const progress = callRemainingMs / CALL_DURATION_MS;
  const qualityColor = QUALITY_COLORS[connectionQuality];
  const qualityLabel = QUALITY_LABELS[connectionQuality];

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      {remoteStream ? (
        <VideoElement stream={remoteStream} className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/60">
          <div className="text-6xl animate-pulse">📡</div>
          <p>Connecting to {partnerName}…</p>
        </div>
      )}

      {/* Warning flash overlay */}
      <AnimatePresence>
        {warning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.25, 0] }}
            exit={{ opacity: 0 }}
            transition={{ repeat: Infinity, duration: 1 }}
            className="pointer-events-none absolute inset-0 bg-red-500 mix-blend-screen"
          />
        )}
      </AnimatePresence>

      {/* Top HUD */}
      <div className="absolute top-0 inset-x-0 z-20 flex items-center justify-between px-5 py-4 bg-gradient-to-b from-black/60 to-transparent">
        <span className="text-white font-semibold text-lg">{partnerName}</span>
        <div className="relative">
          <CountdownRing progress={progress} warning={warning} size={64} stroke={5} color="#22d3ee" />
          <div className="absolute inset-0 flex items-center justify-center text-white font-mono text-sm">
            {formatSeconds(callRemainingMs)}
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-black/40 backdrop-blur-sm">
          <div
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: qualityColor, boxShadow: `0 0 6px ${qualityColor}` }}
          />
          <span className="text-white/70 text-xs">{qualityLabel}</span>
        </div>
      </div>

      <SelfViewPiP localStream={localStream} />

      {/* Bottom controls */}
      <div className="absolute bottom-0 inset-x-0 z-20 flex items-center justify-center py-6 bg-gradient-to-t from-black/70 to-transparent">
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={onHangup}
          className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-xl text-2xl border-2 border-red-400"
          aria-label="End call"
        >
          📵
        </motion.button>
      </div>
    </div>
  );
}

// ─── Screen: Voting ──────────────────────────────────────────────────────────

function VotingScreen({
  partnerName = 'Partner',
  voteRemainingMs = VOTING_WINDOW_MS,
  onVote
}: Pick<SpeedDatingUIProps, 'partnerName' | 'voteRemainingMs' | 'onVote'>) {
  const [choice, setChoice] = useState<'heart' | 'skip' | null>(null);
  const progress = voteRemainingMs / VOTING_WINDOW_MS;

  function pick(c: 'heart' | 'skip') {
    if (choice) return;
    setChoice(c);
    onVote?.(c);
  }

  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 to-black text-white">
      <p className="text-white/60 mb-2 uppercase tracking-widest text-xs">Did you vibe?</p>
      <h2 className="text-3xl font-bold mb-6">{partnerName}</h2>

      <div className="relative mb-8">
        <CountdownRing progress={progress} size={80} stroke={5} color="#f472b6" />
        <div className="absolute inset-0 flex items-center justify-center text-white font-mono">
          {formatSeconds(voteRemainingMs)}
        </div>
      </div>

      <div className="flex items-center gap-8">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => pick('skip')}
          className={[
            'w-24 h-24 rounded-full flex items-center justify-center text-3xl shadow-xl',
            choice === 'skip' ? 'bg-gray-500 ring-4 ring-white/40' : 'bg-white/10 border border-white/20'
          ].join(' ')}
          aria-label="Skip"
        >
          ➡️
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          onClick={() => pick('heart')}
          className={[
            'w-28 h-28 rounded-full flex items-center justify-center text-4xl shadow-2xl',
            choice === 'heart'
              ? 'bg-gradient-to-br from-pink-500 to-rose-600 ring-4 ring-white/40'
              : 'bg-gradient-to-br from-pink-500 to-rose-600'
          ].join(' ')}
          aria-label="Heart"
        >
          💗
        </motion.button>
      </div>

      <p className="mt-8 text-white/40 text-sm">Both hearts = chat unlocked</p>
    </div>
  );
}

// ─── Screen: Post-call / Card Reveal ─────────────────────────────────────────

function Confetti({ count = 60 }: { count?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }).map((_, i) => ({
        id: i,
        x: Math.random() * 100,
        delay: Math.random() * 0.4,
        duration: 2 + Math.random() * 2,
        color: ['#f472b6', '#22d3ee', '#facc15', '#a78bfa', '#4ade80'][i % 5]
      })),
    [count]
  );
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {pieces.map((p) => (
        <motion.div
          key={p.id}
          initial={{ y: -20, x: `${p.x}%`, opacity: 0 }}
          animate={{ y: '110vh', opacity: [0, 1, 1, 0], rotate: 360 }}
          transition={{ duration: p.duration, delay: p.delay, ease: 'easeIn' }}
          className="absolute w-2 h-3 rounded-sm"
          style={{ backgroundColor: p.color, left: `${p.x}%` }}
        />
      ))}
    </div>
  );
}

function PostCallScreen({
  postCallOutcome,
  onStartChat,
  onRequeue
}: Pick<SpeedDatingUIProps, 'postCallOutcome' | 'onStartChat' | 'onRequeue'>) {
  const content = useMemo(() => {
    if (!postCallOutcome) return null;
    switch (postCallOutcome.kind) {
      case 'mutual-match':
        return {
          title: 'They liked you back!',
          subtitle: `You and ${postCallOutcome.partnerName} matched`,
          emoji: '🎉',
          primary: 'Start chatting',
          secondary: 'Next person'
        };
      case 'they-liked-you':
        return {
          title: `${postCallOutcome.partnerName} liked you!`,
          subtitle: 'You passed — but they were into it. Keep going!',
          emoji: '💫',
          primary: 'Next person',
          secondary: null as string | null
        };
      case 'you-liked-them':
        return {
          title: 'Not this time',
          subtitle: `${postCallOutcome.partnerName} was not feeling it — but plenty more ahead.`,
          emoji: '💪',
          primary: 'Next person',
          secondary: null as string | null
        };
      case 'no-match':
        return {
          title: 'Keep going!',
          subtitle: `You and ${postCallOutcome.partnerName} both skipped. On to the next.`,
          emoji: '➡️',
          primary: 'Next person',
          secondary: null as string | null
        };
      case 'no-votes':
      default:
        return {
          title: 'Time ran out',
          subtitle: 'Neither of you voted in time.',
          emoji: '⏰',
          primary: 'Next person',
          secondary: null as string | null
        };
    }
  }, [postCallOutcome]);

  if (!postCallOutcome || !content) return null;
  const isMatch = postCallOutcome.kind === 'mutual-match';
  const isFomo = postCallOutcome.kind === 'they-liked-you';
  const { title, subtitle, emoji, primary, secondary } = content;

  const gradient = isMatch
    ? 'from-pink-500 via-fuchsia-500 to-violet-600'
    : isFomo
      ? 'from-amber-500 via-rose-500 to-pink-600'
      : 'from-slate-700 to-slate-900';

  function primaryAction() {
    if (postCallOutcome && postCallOutcome.kind === 'mutual-match') {
      onStartChat?.(postCallOutcome.chatRoomId);
      return;
    }
    onRequeue?.();
  }

  return (
    <div className={`relative w-full h-full flex items-center justify-center bg-gradient-to-br ${gradient} text-white overflow-hidden`}>
      {isMatch && <Confetti />}
      <motion.div
        initial={{ scale: 0.7, opacity: 0, rotateX: -40 }}
        animate={{ scale: 1, opacity: 1, rotateX: 0 }}
        transition={{ type: 'spring', stiffness: 180, damping: 18 }}
        className="relative z-10 max-w-sm w-full mx-6 rounded-3xl bg-black/30 border border-white/15 backdrop-blur-xl p-8 text-center shadow-2xl"
      >
        <div className="text-6xl mb-4" aria-hidden>{emoji}</div>
        <h2 className="text-2xl font-bold mb-2">{title}</h2>
        <p className="text-white/80 mb-6">{subtitle}</p>
        <button
          onClick={primaryAction}
          className="w-full py-3 rounded-full bg-white text-slate-900 font-semibold shadow-xl hover:bg-white/90"
        >
          {primary}
        </button>
        {secondary && (
          <button
            onClick={onRequeue}
            className="w-full py-2 mt-3 rounded-full bg-white/10 hover:bg-white/20 text-sm"
          >
            {secondary}
          </button>
        )}
      </motion.div>
    </div>
  );
}

// ─── Screen: Stats ───────────────────────────────────────────────────────────

function StatsScreen({ stats, onCloseStats }: Pick<SpeedDatingUIProps, 'stats' | 'onCloseStats'>) {
  const s = stats ?? { matchesToday: 0, totalCalls: 0, matchRatePercent: 0, bestStreak: 0 };
  const cards = [
    { label: 'Matches today', value: s.matchesToday, emoji: '💗' },
    { label: 'Total calls', value: s.totalCalls, emoji: '📞' },
    { label: 'Match rate', value: `${clampPct(s.matchRatePercent).toFixed(0)}%`, emoji: '🎯' },
    { label: 'Best streak', value: s.bestStreak, emoji: '🔥' }
  ];
  return (
    <div className="relative w-full h-full bg-gradient-to-b from-slate-950 to-black text-white p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Your stats</h2>
        <button
          onClick={onCloseStats}
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"
          aria-label="Close stats"
        >
          ✕
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {cards.map((c) => (
          <motion.div
            key={c.label}
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="rounded-2xl bg-white/5 border border-white/10 p-5"
          >
            <div className="text-3xl mb-2">{c.emoji}</div>
            <div className="text-3xl font-bold">{c.value}</div>
            <div className="text-white/60 text-sm">{c.label}</div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ─── Screen: Idle / entry ────────────────────────────────────────────────────

function IdleScreen({
  happyHourActive,
  themeNight,
  onJoin,
  onOpenStats
}: Pick<SpeedDatingUIProps, 'happyHourActive' | 'themeNight' | 'onJoin' | 'onOpenStats'>) {
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center bg-gradient-to-b from-indigo-950 via-fuchsia-950 to-black text-white">
      <h1 className="text-4xl font-extrabold mb-1">Speed Dating</h1>
      <p className="text-white/60 mb-8">60-second video roulette</p>
      {happyHourActive && (
        <div className="mb-3 px-4 py-1.5 rounded-full bg-pink-500/80 text-sm font-semibold">
          ✨ Happy Hour is on — 2× match rate
        </div>
      )}
      {themeNight && (
        <div className="mb-6 text-xs uppercase tracking-widest text-white/70">Tonight&apos;s theme: {themeNight}</div>
      )}
      <motion.button
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        onClick={onJoin}
        className="px-10 py-4 rounded-full bg-gradient-to-r from-pink-500 to-violet-500 font-bold text-lg shadow-2xl"
      >
        Start matching
      </motion.button>
      <button
        onClick={onOpenStats}
        className="mt-6 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-sm"
      >
        📊 My stats
      </button>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function SpeedDatingUI(props: SpeedDatingUIProps) {
  const {
    phase,
    estimatedWaitMs,
    queueDepth,
    countdownRemainingMs,
    inFreeCancelWindow,
    partnerName,
    partnerAge,
    remoteStream,
    localStream,
    callRemainingMs,
    connectionQuality,
    voteRemainingMs,
    postCallOutcome,
    stats,
    happyHourActive,
    themeNight,
    onJoin,
    onLeave,
    onAccept,
    onCancel,
    onHangup,
    onVote,
    onOpenStats,
    onCloseStats,
    onStartChat,
    onRequeue
  } = props;

  // Accessibility: announce phase changes to screen readers.
  const liveRegion = useCallback(() => {
    switch (phase) {
      case 'queued':
        return 'Searching for a match.';
      case 'countdown':
        return `Match found with ${partnerName ?? 'someone'}.`;
      case 'in-call':
        return 'Call in progress.';
      case 'voting':
        return 'Voting window open.';
      case 'post-call':
        if (postCallOutcome?.kind === 'mutual-match') return 'It is a mutual match.';
        if (postCallOutcome?.kind === 'they-liked-you') return 'They liked you.';
        return 'Call ended.';
      case 'stats':
        return 'Viewing stats.';
      default:
        return 'Ready to start matching.';
    }
  }, [phase, partnerName, postCallOutcome]);

  return (
    <div className="fixed inset-0 w-full h-full">
      <span className="sr-only" role="status" aria-live="polite">{liveRegion()}</span>
      <AnimatePresence mode="wait">
        {phase === 'idle' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            <IdleScreen
              happyHourActive={happyHourActive}
              themeNight={themeNight}
              onJoin={onJoin}
              onOpenStats={onOpenStats}
            />
          </motion.div>
        )}
        {phase === 'queued' && (
          <motion.div
            key="queued"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            <QueueScreen
              estimatedWaitMs={estimatedWaitMs}
              queueDepth={queueDepth}
              happyHourActive={happyHourActive}
              themeNight={themeNight}
              onLeave={onLeave}
              onOpenStats={onOpenStats}
            />
          </motion.div>
        )}
        {phase === 'countdown' && (
          <motion.div
            key="countdown"
            initial={{ opacity: 0, scale: 1.02 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            <CountdownScreen
              partnerName={partnerName}
              partnerAge={partnerAge}
              countdownRemainingMs={countdownRemainingMs}
              inFreeCancelWindow={inFreeCancelWindow}
              onAccept={onAccept}
              onCancel={onCancel}
            />
          </motion.div>
        )}
        {phase === 'in-call' && (
          <motion.div
            key="in-call"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            <CallScreen
              partnerName={partnerName}
              remoteStream={remoteStream}
              localStream={localStream}
              callRemainingMs={callRemainingMs}
              connectionQuality={connectionQuality}
              onHangup={onHangup}
            />
          </motion.div>
        )}
        {phase === 'voting' && (
          <motion.div
            key="voting"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            <VotingScreen
              partnerName={partnerName}
              voteRemainingMs={voteRemainingMs}
              onVote={onVote}
            />
          </motion.div>
        )}
        {phase === 'post-call' && (
          <motion.div
            key="post-call"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            <PostCallScreen
              postCallOutcome={postCallOutcome}
              onStartChat={onStartChat}
              onRequeue={onRequeue}
            />
          </motion.div>
        )}
        {phase === 'stats' && (
          <motion.div
            key="stats"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            <StatsScreen stats={stats} onCloseStats={onCloseStats} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
