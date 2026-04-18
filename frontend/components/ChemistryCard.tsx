'use client';

/**
 * ChemistryCard – animated UI component that reveals a pair's chemistry score
 * with a 2-second anticipation delay followed by a smooth animated reveal.
 *
 * Features:
 *  - Circular SVG progress ring with conic-gradient fill (red → yellow → green).
 *  - "Why You Match" section with icon-labelled compatibility reasons.
 *  - "Watch Out For" section with gentle friction warnings.
 *  - Match quality rating (1–5 stars) to feed back into the model.
 *  - 2-second anticipation delay with a pulsing loader before reveal.
 *
 * Usage:
 * ```tsx
 * <ChemistryCard
 *   score={78}
 *   confidence={0.82}
 *   compatibilityReasons={['🎯 Shared passion for tech and music', '💬 Same communication rhythm']}
 *   frictionWarnings={['⚠️ Different activity hours']}
 *   conversationStarters={['What album is on repeat for you?']}
 *   headline="Strong chemistry detected ✨"
 *   onRate={(stars) => handleRating(stars)}
 * />
 * ```
 */

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useSpring, useTransform } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChemistryCardProps {
  /** Chemistry score 0–100. */
  score: number;
  /** Confidence level 0–1. */
  confidence: number;
  /** Natural-language compatibility reasons (up to 3). */
  compatibilityReasons: string[];
  /** Gentle friction warnings (up to 2). */
  frictionWarnings: string[];
  /** Suggested conversation starters (up to 5). */
  conversationStarters: string[];
  /** Headline text summarising the chemistry. */
  headline: string;
  /**
   * Called when the user submits a 1–5 star rating for this match.
   * Intended to feed back into ChemistryPredictor.recordMatchOutcome.
   */
  onRate?: (stars: number) => void;
  /**
   * If true, skips the 2-second anticipation delay (useful in test environments).
   * Default: false.
   */
  skipDelay?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Duration of the anticipation phase before the score is revealed (ms). */
const ANTICIPATION_DELAY_MS = 2000;

/** Duration of the animated ring fill (ms). */
const RING_ANIMATION_DURATION_MS = 1200;

/** Ring SVG dimensions. */
const RING_SIZE       = 160;
const RING_STROKE     = 14;
const RING_RADIUS     = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map a 0–100 score to a CSS hex colour (red → yellow → green). */
function scoreToColor(score: number): string {
  const clamped = Math.max(0, Math.min(100, score));

  if (clamped < 50) {
    // Red (0°, 100%, 50%) → Yellow (60°, 100%, 50%)
    const t = clamped / 50;
    const h = Math.round(t * 60);
    return `hsl(${h}, 85%, 52%)`;
  } else {
    // Yellow (60°) → Green (120°)
    const t = (clamped - 50) / 50;
    const h = Math.round(60 + t * 60);
    return `hsl(${h}, 75%, 45%)`;
  }
}

/** Derive a text label from the score. */
function scoreLabel(score: number): string {
  if (score >= 80) return 'Exceptional';
  if (score >= 65) return 'Strong';
  if (score >= 50) return 'Promising';
  if (score >= 35) return 'Moderate';
  return 'Growing';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// ── Anticipation loader ──────────────────────────────────────────────────────

function AnticipationLoader() {
  return (
    <motion.div
      className="flex flex-col items-center justify-center gap-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Pulsing ring placeholder */}
      <div className="relative w-40 h-40 flex items-center justify-center">
        <motion.div
          className="absolute inset-0 rounded-full border-4 border-white/10"
          animate={{ scale: [1, 1.06, 1], opacity: [0.4, 0.7, 0.4] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute inset-2 rounded-full border-4 border-white/5"
          animate={{ scale: [1.06, 1, 1.06], opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
        />
        <motion.div
          className="text-white/40 text-base font-medium"
          animate={{ opacity: [0.4, 0.9, 0.4] }}
          transition={{ duration: 1.4, repeat: Infinity }}
        >
          Analysing…
        </motion.div>
      </div>

      {/* Skeleton placeholder bars */}
      <div className="w-full space-y-2 px-2">
        {[70, 50, 60].map((width, i) => (
          <motion.div
            key={i}
            className="h-3 rounded-full bg-white/10"
            style={{ width: `${width}%` }}
            animate={{ opacity: [0.3, 0.6, 0.3] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15 }}
          />
        ))}
      </div>
    </motion.div>
  );
}

// ── Chemistry ring ────────────────────────────────────────────────────────────

interface ChemistryRingProps {
  score: number;
  confidence: number;
  visible: boolean;
}

function ChemistryRing({ score, confidence, visible }: ChemistryRingProps) {
  const color = scoreToColor(score);
  const label = scoreLabel(score);
  const confidencePct = Math.round(confidence * 100);

  // Animate the stroke-dashoffset from full circumference (empty) to target.
  const targetOffset = RING_CIRCUMFERENCE * (1 - score / 100);

  // Animated numeric counter for the score display.
  const [displayScore, setDisplayScore] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const start = performance.now();
    const duration = RING_ANIMATION_DURATION_MS;

    function tick(now: number) {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayScore(Math.round(eased * score));
      if (t < 1) requestAnimationFrame(tick);
    }

    const raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, score]);

  return (
    <div className="flex flex-col items-center gap-3">
      {/* SVG ring */}
      <div className="relative flex items-center justify-center" style={{ width: RING_SIZE, height: RING_SIZE }}>
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          style={{ transform: 'rotate(-90deg)' }}
          aria-label={`Chemistry score: ${score} out of 100`}
        >
          {/* Background track */}
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={RING_STROKE}
          />
          {/* Animated progress arc */}
          <motion.circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            initial={{ strokeDashoffset: RING_CIRCUMFERENCE }}
            animate={visible ? { strokeDashoffset: targetOffset } : { strokeDashoffset: RING_CIRCUMFERENCE }}
            transition={{ duration: RING_ANIMATION_DURATION_MS / 1000, ease: 'easeOut', delay: 0.1 }}
            style={{ filter: `drop-shadow(0 0 8px ${color})` }}
          />
        </svg>

        {/* Centre label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-4xl font-black text-white tabular-nums leading-none">
            {displayScore}
          </span>
          <span className="text-xs text-white/50 font-medium mt-0.5">/ 100</span>
          <span
            className="text-xs font-semibold mt-1 px-2 py-0.5 rounded-full"
            style={{ color, backgroundColor: color + '22' }}
          >
            {label}
          </span>
        </div>
      </div>

      {/* Confidence badge */}
      <div className="flex items-center gap-1.5 text-xs text-white/50">
        <span className="w-1.5 h-1.5 rounded-full bg-white/30 inline-block" />
        <span>{confidencePct}% confidence</span>
      </div>
    </div>
  );
}

// ── Compatibility reason row ──────────────────────────────────────────────────

interface ReasonRowProps {
  text: string;
  index: number;
  visible: boolean;
}

function ReasonRow({ text, index, visible }: ReasonRowProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={visible ? { opacity: 1, x: 0 } : { opacity: 0, x: -12 }}
      transition={{ duration: 0.4, delay: 0.1 + index * 0.12, ease: 'easeOut' }}
      className="flex items-start gap-2 py-1.5 px-3 rounded-xl bg-white/5 hover:bg-white/8 transition-colors"
    >
      <span className="text-base leading-snug flex-shrink-0 mt-0.5">
        {/* First character is the emoji */}
        {text.charAt(0)}
      </span>
      <span className="text-sm text-white/80 leading-snug">
        {text.slice(2)}
      </span>
    </motion.div>
  );
}

// ── Friction warning row ──────────────────────────────────────────────────────

interface WarningRowProps {
  text: string;
  index: number;
  visible: boolean;
}

function WarningRow({ text, index, visible }: WarningRowProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={visible ? { opacity: 1, x: 0 } : { opacity: 0, x: -12 }}
      transition={{ duration: 0.4, delay: 0.25 + index * 0.12, ease: 'easeOut' }}
      className="flex items-start gap-2 py-1.5 px-3 rounded-xl bg-orange-500/10 border border-orange-500/20"
    >
      <span className="text-sm text-orange-300/80 leading-snug">
        {text}
      </span>
    </motion.div>
  );
}

// ── Star rating ───────────────────────────────────────────────────────────────

interface StarRatingProps {
  onRate: (stars: number) => void;
}

function StarRating({ onRate }: StarRatingProps) {
  const [hovered, setHovered] = useState(0);
  const [selected, setSelected] = useState(0);

  function handleSelect(stars: number) {
    setSelected(stars);
    onRate(stars);
  }

  return (
    <motion.div
      className="flex flex-col items-center gap-2"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.6 }}
    >
      <p className="text-xs text-white/40 text-center">Rate this match after your call</p>
      <div className="flex gap-1" role="group" aria-label="Rate this match">
        {[1, 2, 3, 4, 5].map((star) => (
          <motion.button
            key={star}
            aria-label={`${star} star${star !== 1 ? 's' : ''}`}
            aria-pressed={selected === star}
            whileTap={{ scale: 0.85 }}
            whileHover={{ scale: 1.2 }}
            onClick={() => handleSelect(star)}
            onMouseEnter={() => setHovered(star)}
            onMouseLeave={() => setHovered(0)}
            className="text-2xl transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 rounded"
          >
            <span
              style={{
                filter: (hovered || selected) >= star
                  ? 'none'
                  : 'grayscale(1) opacity(0.3)',
              }}
            >
              ⭐
            </span>
          </motion.button>
        ))}
      </div>
      {selected > 0 && (
        <motion.p
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-xs text-yellow-400/80"
        >
          Thanks for the feedback!
        </motion.p>
      )}
    </motion.div>
  );
}

// ── Conversation starter ──────────────────────────────────────────────────────

interface StarterChipProps {
  text: string;
  index: number;
  visible: boolean;
}

function StarterChip({ text, index, visible }: StarterChipProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
      transition={{ duration: 0.35, delay: 0.1 + index * 0.08 }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      onClick={handleCopy}
      className="w-full text-left text-xs text-white/70 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl px-3 py-2.5 transition-colors flex items-start gap-2 group"
      aria-label={`Conversation starter: ${text}. Click to copy.`}
    >
      <span className="text-white/30 group-hover:text-white/60 transition-colors flex-shrink-0 mt-px">💬</span>
      <span className="flex-1 leading-snug">{text}</span>
      <span className="flex-shrink-0 text-white/30 group-hover:text-white/60 transition-colors">
        {copied ? '✓' : '⎘'}
      </span>
    </motion.button>
  );
}

// ─── ChemistryCard ────────────────────────────────────────────────────────────

/**
 * Main Chemistry Card component.
 *
 * Renders a two-phase UI:
 *   Phase 1 (0 – ANTICIPATION_DELAY_MS): animated skeleton / pulsing ring loader.
 *   Phase 2 (ANTICIPATION_DELAY_MS+): full chemistry reveal with animated score ring.
 */
export default function ChemistryCard({
  score,
  confidence,
  compatibilityReasons,
  frictionWarnings,
  conversationStarters,
  headline,
  onRate,
  skipDelay = false,
}: ChemistryCardProps) {
  const [phase, setPhase] = useState<'anticipation' | 'reveal'>(
    skipDelay ? 'reveal' : 'anticipation'
  );
  const [showStarters, setShowStarters] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (skipDelay) {
      setPhase('reveal');
      return;
    }
    timerRef.current = setTimeout(() => {
      setPhase('reveal');
    }, ANTICIPATION_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [skipDelay]);

  const scoreColor = scoreToColor(score);

  return (
    <div
      className="relative w-full max-w-sm mx-auto rounded-3xl overflow-hidden bg-gray-900/90 backdrop-blur-xl border border-white/8 shadow-2xl"
      style={{ boxShadow: `0 0 60px ${scoreColor}22, 0 8px 32px rgba(0,0,0,0.5)` }}
    >
      {/* Top accent bar */}
      <motion.div
        className="h-1 w-full"
        style={{ background: `linear-gradient(90deg, ${scoreColor}44, ${scoreColor}, ${scoreColor}44)` }}
        animate={phase === 'reveal' ? { opacity: 1 } : { opacity: 0.3 }}
        transition={{ duration: 0.8 }}
      />

      <div className="p-5 flex flex-col gap-5">
        {/* ── Phase transition ── */}
        <AnimatePresence mode="wait">
          {phase === 'anticipation' ? (
            <motion.div key="anticipation">
              <AnticipationLoader />
            </motion.div>
          ) : (
            <motion.div
              key="reveal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5 }}
              className="flex flex-col gap-5"
            >
              {/* ── Headline ── */}
              <motion.h2
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="text-white font-bold text-base text-center leading-snug"
              >
                {headline}
              </motion.h2>

              {/* ── Chemistry ring ── */}
              <div className="flex justify-center">
                <ChemistryRing
                  score={score}
                  confidence={confidence}
                  visible={phase === 'reveal'}
                />
              </div>

              {/* ── Why You Match ── */}
              {compatibilityReasons.length > 0 && (
                <motion.section
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4, delay: 0.2 }}
                  aria-label="Why you match"
                >
                  <h3 className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-2 px-1">
                    Why You Match
                  </h3>
                  <div className="flex flex-col gap-1.5">
                    {compatibilityReasons.slice(0, 3).map((reason, i) => (
                      <ReasonRow
                        key={i}
                        text={reason}
                        index={i}
                        visible={phase === 'reveal'}
                      />
                    ))}
                  </div>
                </motion.section>
              )}

              {/* ── Watch Out For ── */}
              {frictionWarnings.length > 0 && (
                <motion.section
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4, delay: 0.35 }}
                  aria-label="Potential friction points"
                >
                  <h3 className="text-xs font-semibold text-orange-400/50 uppercase tracking-widest mb-2 px-1">
                    Watch Out For
                  </h3>
                  <div className="flex flex-col gap-1.5">
                    {frictionWarnings.slice(0, 2).map((warning, i) => (
                      <WarningRow
                        key={i}
                        text={warning}
                        index={i}
                        visible={phase === 'reveal'}
                      />
                    ))}
                  </div>
                </motion.section>
              )}

              {/* ── Conversation starters ── */}
              {conversationStarters.length > 0 && (
                <motion.section
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4, delay: 0.45 }}
                  aria-label="Conversation starters"
                >
                  <button
                    onClick={() => setShowStarters((s) => !s)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-white/40 uppercase tracking-widest mb-2 px-1 hover:text-white/70 transition-colors w-full"
                    aria-expanded={showStarters}
                  >
                    <span>Conversation Starters</span>
                    <motion.span
                      animate={{ rotate: showStarters ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      ▾
                    </motion.span>
                  </button>

                  <AnimatePresence>
                    {showStarters && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="overflow-hidden flex flex-col gap-1.5"
                      >
                        {conversationStarters.slice(0, 5).map((starter, i) => (
                          <StarterChip
                            key={i}
                            text={starter}
                            index={i}
                            visible={showStarters}
                          />
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.section>
              )}

              {/* ── Star rating ── */}
              {onRate && (
                <div className="border-t border-white/8 pt-4">
                  <StarRating onRate={onRate} />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom accent glow */}
      <motion.div
        className="absolute inset-x-0 bottom-0 h-24 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse at 50% 100%, ${scoreColor}18 0%, transparent 70%)`,
        }}
        animate={phase === 'reveal' ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: 1 }}
      />
    </div>
  );
}
