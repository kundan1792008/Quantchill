'use client';

/**
 * SwipeStack — Framer-Motion powered, physics-based card stack.
 *
 * Interaction model (mobile-first, pointer events):
 *   - Horizontal drag right past `swipeThreshold` → LIKE.
 *   - Horizontal drag left past `-swipeThreshold` → SKIP.
 *   - Vertical drag up past `-verticalThreshold`  → SUPERLIKE.
 *   - Velocity-based completion: if velocity.x > 800 px/s the throw is
 *     accepted even when the displacement is below threshold.
 *   - Springs back to rest otherwise.
 *
 * Visuals:
 *   - The current card is on top.
 *   - The next 3 cards are stacked behind with a parallax (scale + Y offset).
 *   - A translucent gradient overlay colour-codes the active intent
 *     (green = like, red = skip, purple = superlike) as the user drags.
 *   - A small "ELO" badge, name label, and tag chips are rendered per card.
 *
 * Networking:
 *   - The component is deliberately dumb about transport. Parents pass a
 *     `onSwipe` callback that receives `{card, action, velocity, durationMs}`.
 *     A Fastify/WebSocket hook in the parent is responsible for calling
 *     `/api/swipe` or sending the swipe event down the match websocket.
 */

import {
  motion,
  useMotionValue,
  useTransform,
  useAnimationControls,
  AnimatePresence,
  PanInfo
} from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type SwipeAction = 'like' | 'skip' | 'superlike';

export interface SwipeCard {
  id: string;
  name: string;
  age?: number;
  elo: number;
  tags: string[];
  /** URL to a video stream or static poster image. */
  mediaUrl: string;
  /** If true, render as a looping muted video instead of an <img>. */
  isVideo?: boolean;
  /** Optional short bio shown under the tags. */
  bio?: string;
}

export interface SwipeStackProps {
  cards: SwipeCard[];
  onSwipe: (event: SwipeEventPayload) => void;
  onEmpty?: () => void;
  /** Horizontal distance (px) after which a drag is accepted as like/skip. */
  swipeThreshold?: number;
  /** Vertical (upward) distance (px) after which a drag is accepted as superlike. */
  verticalThreshold?: number;
  /** Flick velocity (px/s) over which a drag is accepted below threshold. */
  velocityThreshold?: number;
  /** Number of stacked "behind" cards to render (0 = only current). */
  visibleBehind?: number;
  /** Optional rendering override per card. */
  renderMeta?: (card: SwipeCard) => React.ReactNode;
}

export interface SwipeEventPayload {
  card: SwipeCard;
  action: SwipeAction;
  velocity: { x: number; y: number };
  durationMs: number;
}

/** Helpers exported for unit testing the pure parts of the stack. */
export function classifySwipe(
  offset: { x: number; y: number },
  velocity: { x: number; y: number },
  thresholds: { x: number; y: number; v: number }
): SwipeAction | null {
  const dominantX = Math.abs(offset.x) >= Math.abs(offset.y);

  if (!dominantX && offset.y < -thresholds.y) return 'superlike';
  if (!dominantX && velocity.y < -thresholds.v) return 'superlike';

  if (offset.x > thresholds.x) return 'like';
  if (offset.x < -thresholds.x) return 'skip';

  if (velocity.x > thresholds.v) return 'like';
  if (velocity.x < -thresholds.v) return 'skip';

  return null;
}

/** Pure geometry — next-card parallax transform values. */
export function parallaxTransform(depth: number): { scale: number; y: number; opacity: number } {
  // depth = 0 is the active card, 1 is directly behind, etc.
  if (depth <= 0) return { scale: 1, y: 0, opacity: 1 };
  return {
    scale: Math.max(0.85, 1 - depth * 0.05),
    y: depth * 14,
    opacity: Math.max(0.4, 1 - depth * 0.25)
  };
}

const DEFAULT_THRESHOLDS = {
  swipeThreshold: 120,
  verticalThreshold: 140,
  velocityThreshold: 800,
  visibleBehind: 3
};

export default function SwipeStack({
  cards,
  onSwipe,
  onEmpty,
  swipeThreshold = DEFAULT_THRESHOLDS.swipeThreshold,
  verticalThreshold = DEFAULT_THRESHOLDS.verticalThreshold,
  velocityThreshold = DEFAULT_THRESHOLDS.velocityThreshold,
  visibleBehind = DEFAULT_THRESHOLDS.visibleBehind,
  renderMeta
}: SwipeStackProps) {
  const [index, setIndex] = useState(0);
  const activeCard = cards[index];
  const startedAtRef = useRef<number>(performance.now());

  useEffect(() => {
    startedAtRef.current = performance.now();
  }, [index]);

  useEffect(() => {
    if (!activeCard && onEmpty) onEmpty();
  }, [activeCard, onEmpty]);

  const completeSwipe = useCallback(
    (action: SwipeAction, velocity: { x: number; y: number }) => {
      if (!activeCard) return;
      const durationMs = performance.now() - startedAtRef.current;
      onSwipe({ card: activeCard, action, velocity, durationMs });
      setIndex((i) => i + 1);
    },
    [activeCard, onSwipe]
  );

  const behind = useMemo(() => cards.slice(index + 1, index + 1 + visibleBehind), [
    cards,
    index,
    visibleBehind
  ]);

  return (
    <div className="relative h-[640px] w-full max-w-[380px] mx-auto select-none">
      {/* Behind-stack cards (rendered bottom-up so z-order is correct) */}
      {behind
        .map((card, i) => ({ card, depth: behind.length - i }))
        .reverse()
        .map(({ card, depth }) => (
          <StaticStackCard key={card.id} card={card} depth={depth} renderMeta={renderMeta} />
        ))}

      <AnimatePresence initial={false}>
        {activeCard && (
          <ActiveCard
            key={activeCard.id}
            card={activeCard}
            thresholds={{
              x: swipeThreshold,
              y: verticalThreshold,
              v: velocityThreshold
            }}
            onComplete={completeSwipe}
            renderMeta={renderMeta}
          />
        )}
      </AnimatePresence>

      {!activeCard && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-white/60">
          <span className="text-sm tracking-widest">QUEUE EMPTY</span>
          <span className="mt-2 text-xs text-white/40">
            Keep scrolling — fresh candidates arriving shortly.
          </span>
        </div>
      )}
    </div>
  );
}

interface ActiveCardProps {
  card: SwipeCard;
  thresholds: { x: number; y: number; v: number };
  onComplete: (action: SwipeAction, velocity: { x: number; y: number }) => void;
  renderMeta?: (card: SwipeCard) => React.ReactNode;
}

function ActiveCard({ card, thresholds, onComplete, renderMeta }: ActiveCardProps) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-200, 0, 200], [-14, 0, 14]);
  const likeOpacity = useTransform(x, [40, thresholds.x], [0, 1]);
  const skipOpacity = useTransform(x, [-thresholds.x, -40], [1, 0]);
  const superOpacity = useTransform(y, [-thresholds.y, -40], [1, 0]);
  const controls = useAnimationControls();

  const handleDragEnd = async (_: unknown, info: PanInfo) => {
    const action = classifySwipe(info.offset, info.velocity, thresholds);
    if (action === 'like' || action === 'superlike') {
      await controls.start({
        x: action === 'like' ? 800 : 0,
        y: action === 'superlike' ? -900 : 0,
        opacity: 0,
        transition: { duration: 0.35, ease: [0.19, 1, 0.22, 1] }
      });
      onComplete(action, info.velocity);
      return;
    }
    if (action === 'skip') {
      await controls.start({
        x: -800,
        opacity: 0,
        transition: { duration: 0.35, ease: [0.19, 1, 0.22, 1] }
      });
      onComplete('skip', info.velocity);
      return;
    }
    // No decision — spring back.
    void controls.start({
      x: 0,
      y: 0,
      transition: { type: 'spring', stiffness: 380, damping: 28 }
    });
  };

  return (
    <motion.div
      drag
      dragElastic={0.6}
      dragMomentum={false}
      style={{ x, y, rotate }}
      animate={controls}
      initial={{ scale: 0.95, opacity: 0 }}
      whileInView={{ scale: 1, opacity: 1 }}
      onDragEnd={handleDragEnd}
      className="absolute inset-0 cursor-grab active:cursor-grabbing"
    >
      <CardSurface card={card} renderMeta={renderMeta}>
        <motion.div
          aria-hidden
          style={{ opacity: likeOpacity }}
          className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-500/40 via-transparent to-transparent"
        />
        <motion.div
          aria-hidden
          style={{ opacity: skipOpacity }}
          className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-rose-500/40 via-transparent to-transparent"
        />
        <motion.div
          aria-hidden
          style={{ opacity: superOpacity }}
          className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-t from-fuchsia-500/40 via-transparent to-transparent"
        />
      </CardSurface>
    </motion.div>
  );
}

interface StaticCardProps {
  card: SwipeCard;
  depth: number;
  renderMeta?: (card: SwipeCard) => React.ReactNode;
}

function StaticStackCard({ card, depth, renderMeta }: StaticCardProps) {
  const { scale, y, opacity } = parallaxTransform(depth);
  return (
    <motion.div
      style={{ scale, y, opacity }}
      aria-hidden
      className="absolute inset-0 pointer-events-none"
    >
      <CardSurface card={card} renderMeta={renderMeta} />
    </motion.div>
  );
}

interface CardSurfaceProps {
  card: SwipeCard;
  children?: React.ReactNode;
  renderMeta?: (card: SwipeCard) => React.ReactNode;
}

function CardSurface({ card, children, renderMeta }: CardSurfaceProps) {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl shadow-black/50">
      {card.isVideo ? (
        <video
          src={card.mediaUrl}
          className="h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={card.mediaUrl} alt={card.name} className="h-full w-full object-cover" />
      )}

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/85 via-black/50 to-transparent p-5 text-white">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-semibold tracking-wide">
            {card.name}
            {typeof card.age === 'number' ? <span className="ml-2 font-light">{card.age}</span> : null}
          </h3>
          <span className="rounded-full border border-white/20 bg-white/10 px-3 py-0.5 text-xs tracking-widest">
            ELO {Math.round(card.elo)}
          </span>
        </div>
        {card.bio ? <p className="text-xs text-white/70">{card.bio}</p> : null}
        {card.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {card.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-white/10 bg-white/10 px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-white/80"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {renderMeta ? renderMeta(card) : null}
      </div>

      {children}
    </div>
  );
}
