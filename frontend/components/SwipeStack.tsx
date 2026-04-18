'use client';

import {
  PanInfo,
  motion,
  useMotionValue,
  useTransform,
  AnimatePresence
} from 'framer-motion';
import { useCallback, useMemo, useState } from 'react';

/**
 * A single card in the swipe stack. `videoStreamUrl` is optional – when omitted,
 * a gradient placeholder is rendered so the component is usable in static SSR
 * previews.
 */
export interface SwipeCard {
  id: string;
  name: string;
  eloRating: number;
  tags: string[];
  videoStreamUrl?: string;
}

/** Direction of a completed swipe. */
export type SwipeDirection = 'left' | 'right' | 'up';

/** Public API for the component. */
export interface SwipeStackProps {
  cards: SwipeCard[];
  /** Called when the user completes a swipe gesture past the threshold. */
  onSwipe?: (card: SwipeCard, direction: SwipeDirection) => void;
  /** Number of cards visible behind the active card. Default 3. */
  visibleDepth?: number;
  /** Horizontal distance (px) at which a swipe is accepted. Default 140. */
  horizontalThreshold?: number;
  /** Vertical distance (px) at which a superlike swipe is accepted. Default 120. */
  verticalThreshold?: number;
  /** Velocity (px/s) that also triggers a swipe. Default 600. */
  velocityThreshold?: number;
}

/**
 * Gesture-based card stack powered by `framer-motion`.
 *
 * Physics behaviour:
 *   - Each card is draggable within a wide bounding box.
 *   - Rotation is bound to horizontal offset (x → rotate) for a natural tilt.
 *   - Opacity falls off as the card leaves the screen so skipped cards fade.
 *   - When the user releases past `horizontalThreshold` / `verticalThreshold`
 *     OR past `velocityThreshold` velocity, the card animates off-screen via a
 *     spring transition and the next card becomes active.
 *   - The next `visibleDepth` cards are rendered behind with a parallax scale
 *     and vertical offset so the stack looks three-dimensional.
 */
export default function SwipeStack({
  cards,
  onSwipe,
  visibleDepth = 3,
  horizontalThreshold = 140,
  verticalThreshold = 120,
  velocityThreshold = 600
}: SwipeStackProps) {
  const [consumed, setConsumed] = useState(0);

  const remaining = useMemo(() => cards.slice(consumed), [cards, consumed]);

  const handleSwipeComplete = useCallback(
    (card: SwipeCard, direction: SwipeDirection) => {
      onSwipe?.(card, direction);
      setConsumed((c) => c + 1);
    },
    [onSwipe]
  );

  if (remaining.length === 0) {
    return (
      <div className="flex h-full min-h-[420px] w-full items-center justify-center rounded-3xl border border-dashed border-white/10 bg-black/20 text-sm tracking-widest text-fog/60">
        NO MORE CANDIDATES
      </div>
    );
  }

  return (
    <div className="relative h-[520px] w-full max-w-md" role="list" aria-label="Swipe stack">
      {remaining
        .slice(0, visibleDepth + 1)
        .map((card, index, arr) => {
          // The top card (index 0) is interactive; the rest are static previews.
          const isTop = index === 0;
          const depth = arr.length - 1 - index; // 0 = back, large = front
          return (
            <SwipeCardView
              key={card.id}
              card={card}
              depth={depth}
              active={isTop}
              horizontalThreshold={horizontalThreshold}
              verticalThreshold={verticalThreshold}
              velocityThreshold={velocityThreshold}
              onSwipeComplete={handleSwipeComplete}
            />
          );
        })
        .reverse()}
    </div>
  );
}

interface SwipeCardViewProps {
  card: SwipeCard;
  depth: number;
  active: boolean;
  horizontalThreshold: number;
  verticalThreshold: number;
  velocityThreshold: number;
  onSwipeComplete: (card: SwipeCard, direction: SwipeDirection) => void;
}

function SwipeCardView({
  card,
  depth,
  active,
  horizontalThreshold,
  verticalThreshold,
  velocityThreshold,
  onSwipeComplete
}: SwipeCardViewProps) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-300, 0, 300], [-18, 0, 18]);
  const likeOpacity = useTransform(x, [40, 180], [0, 1]);
  const skipOpacity = useTransform(x, [-180, -40], [1, 0]);
  const superOpacity = useTransform(y, [-180, -40], [1, 0]);

  const [exitDirection, setExitDirection] = useState<SwipeDirection | null>(null);

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const { offset, velocity } = info;
    const verticalOver =
      offset.y < -verticalThreshold || velocity.y < -velocityThreshold;
    const rightOver =
      offset.x > horizontalThreshold || velocity.x > velocityThreshold;
    const leftOver =
      offset.x < -horizontalThreshold || velocity.x < -velocityThreshold;

    if (verticalOver) {
      setExitDirection('up');
    } else if (rightOver) {
      setExitDirection('right');
    } else if (leftOver) {
      setExitDirection('left');
    }
  };

  // Depth-based visual styling for the stacked preview cards.
  const restingScale = 1 - depth * 0.04;
  const restingY = depth * 16;

  return (
    <AnimatePresence
      onExitComplete={() => {
        if (exitDirection) onSwipeComplete(card, exitDirection);
      }}
    >
      {!exitDirection && (
        <motion.div
          role="listitem"
          aria-hidden={!active}
          drag={active}
          dragElastic={0.6}
          dragMomentum
          dragConstraints={{ left: -600, right: 600, top: -600, bottom: 200 }}
          onDragEnd={active ? handleDragEnd : undefined}
          style={active ? { x, y, rotate } : {}}
          initial={{ scale: restingScale * 0.98, y: restingY + 20, opacity: 0 }}
          animate={{ scale: restingScale, y: restingY, opacity: 1 }}
          exit={
            exitDirection === 'up'
              ? { y: -900, opacity: 0, transition: { duration: 0.35 } }
              : exitDirection === 'right'
              ? { x: 900, rotate: 24, opacity: 0, transition: { duration: 0.35 } }
              : exitDirection === 'left'
              ? { x: -900, rotate: -24, opacity: 0, transition: { duration: 0.35 } }
              : { opacity: 0 }
          }
          transition={{ type: 'spring', stiffness: 220, damping: 26 }}
          className="absolute inset-0 overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-aurora/30 via-teal/20 to-black shadow-2xl"
        >
          {/* Video / fallback gradient */}
          <CardMedia card={card} />

          {/* Action labels (visible during drag) */}
          {active && (
            <>
              <motion.span
                style={{ opacity: likeOpacity }}
                className="absolute left-6 top-6 rounded-full border-2 border-emerald-400 px-3 py-1 text-sm font-semibold tracking-widest text-emerald-400"
              >
                LIKE
              </motion.span>
              <motion.span
                style={{ opacity: skipOpacity }}
                className="absolute right-6 top-6 rounded-full border-2 border-rose-400 px-3 py-1 text-sm font-semibold tracking-widest text-rose-400"
              >
                SKIP
              </motion.span>
              <motion.span
                style={{ opacity: superOpacity }}
                className="absolute left-1/2 top-8 -translate-x-1/2 rounded-full border-2 border-sky-300 px-3 py-1 text-sm font-semibold tracking-widest text-sky-300"
              >
                SUPERLIKE
              </motion.span>
            </>
          )}

          {/* Footer metadata */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-5 text-fog">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-lg font-semibold">{card.name}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {card.tags.slice(0, 4).map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              <EloBadge rating={card.eloRating} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CardMedia({ card }: { card: SwipeCard }) {
  if (card.videoStreamUrl) {
    return (
      <video
        key={card.videoStreamUrl}
        src={card.videoStreamUrl}
        autoPlay
        playsInline
        muted
        loop
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="h-full w-full bg-gradient-to-br from-aurora/40 via-teal/30 to-midnight"
    />
  );
}

function EloBadge({ rating }: { rating: number }) {
  const bracket =
    rating >= 1600
      ? 'diamond'
      : rating >= 1400
      ? 'platinum'
      : rating >= 1200
      ? 'gold'
      : rating >= 1000
      ? 'silver'
      : 'bronze';
  const color =
    bracket === 'diamond'
      ? 'text-sky-300 border-sky-300'
      : bracket === 'platinum'
      ? 'text-zinc-200 border-zinc-200'
      : bracket === 'gold'
      ? 'text-amber-300 border-amber-300'
      : bracket === 'silver'
      ? 'text-zinc-300 border-zinc-400'
      : 'text-orange-400 border-orange-400';
  return (
    <span
      className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-widest ${color}`}
      aria-label={`ELO ${rating}`}
    >
      {bracket} · {rating}
    </span>
  );
}
