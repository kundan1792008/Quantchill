'use client';

import { useState, useRef } from 'react';
import {
  motion,
  useMotionValue,
  useTransform,
  useAnimation,
  PanInfo
} from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CardData {
  id: string;
  name: string;
  age?: number;
  eloRating?: number;
  tags?: string[];
  avatarUrl?: string;
  /** Active WebRTC stream (if video is live). */
  stream?: MediaStream;
}

export interface SwipeStackProps {
  cards: CardData[];
  onLike?: (card: CardData) => void;
  onSkip?: (card: CardData) => void;
  onSuperlike?: (card: CardData) => void;
  onEmpty?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function eloBadgeColor(elo?: number): string {
  if (!elo) return '#888';
  if (elo >= 1600) return '#a78bfa'; // diamond – violet
  if (elo >= 1400) return '#38bdf8'; // platinum – sky
  if (elo >= 1200) return '#fbbf24'; // gold
  if (elo >= 1000) return '#9ca3af'; // silver
  return '#b45309';                   // bronze
}

function eloBracketLabel(elo?: number): string {
  if (!elo) return '—';
  if (elo >= 1600) return '💎 Diamond';
  if (elo >= 1400) return '🌊 Platinum';
  if (elo >= 1200) return '⭐ Gold';
  if (elo >= 1000) return '🥈 Silver';
  return '🥉 Bronze';
}

// ─── VideoCard ────────────────────────────────────────────────────────────────

function VideoCard({ card }: { card: CardData }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach MediaStream when the element mounts.
  if (videoRef.current && card.stream) {
    videoRef.current.srcObject = card.stream;
  }

  return (
    <div className="relative w-full h-full rounded-3xl overflow-hidden bg-gray-900 select-none">
      {card.stream ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          {card.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.avatarUrl}
              alt={card.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="text-6xl">👤</div>
          )}
        </div>
      )}

      {/* Gradient overlay */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/80 to-transparent" />

      {/* Name & ELO */}
      <div className="absolute bottom-4 left-4 right-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-white text-2xl font-bold">{card.name}</span>
          {card.age && (
            <span className="text-white/70 text-lg">{card.age}</span>
          )}
        </div>

        <div
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ backgroundColor: eloBadgeColor(card.eloRating) + '33', color: eloBadgeColor(card.eloRating) }}
        >
          {eloBracketLabel(card.eloRating)}
          {card.eloRating && <span className="opacity-70 ml-1">({card.eloRating})</span>}
        </div>

        {card.tags && card.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {card.tags.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 rounded-full text-xs bg-white/10 text-white/80 backdrop-blur-sm"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SwipeCard (individual draggable card) ────────────────────────────────────

interface SwipeCardProps {
  card: CardData;
  stackIndex: number; // 0 = top, 1, 2 = behind
  total: number;
  onLike: (card: CardData, velocity: number) => void;
  onSkip: (card: CardData, velocity: number) => void;
  onSuperlike: (card: CardData, velocity: number) => void;
}

function SwipeCard({ card, stackIndex, onLike, onSkip, onSuperlike }: SwipeCardProps) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const controls = useAnimation();

  const rotate = useTransform(x, [-200, 0, 200], [-18, 0, 18]);
  const likeOpacity = useTransform(x, [30, 120], [0, 1]);
  const skipOpacity = useTransform(x, [-120, -30], [1, 0]);
  const superlikeOpacity = useTransform(y, [-120, -40], [1, 0]);

  const isTop = stackIndex === 0;

  // Parallax: cards behind the top are scaled down and shifted up slightly.
  const scale = 1 - stackIndex * 0.045;
  const translateY = stackIndex * -12;

  async function handleDragEnd(_: unknown, info: PanInfo) {
    const velocityX = info.velocity.x;
    const velocityY = info.velocity.y;
    const offsetX = info.offset.x;
    const offsetY = info.offset.y;

    const SWIPE_THRESHOLD_X = 100;
    const SWIPE_THRESHOLD_Y = -100;
    const VELOCITY_THRESHOLD = 500;

    if (offsetY < SWIPE_THRESHOLD_Y || velocityY < -VELOCITY_THRESHOLD) {
      // Swipe up = superlike.
      await controls.start({ y: -600, opacity: 0, transition: { duration: 0.35 } });
      onSuperlike(card, Math.abs(velocityY));
    } else if (offsetX > SWIPE_THRESHOLD_X || velocityX > VELOCITY_THRESHOLD) {
      // Swipe right = like.
      await controls.start({ x: 600, rotate: 20, opacity: 0, transition: { duration: 0.35 } });
      onLike(card, velocityX);
    } else if (offsetX < -SWIPE_THRESHOLD_X || velocityX < -VELOCITY_THRESHOLD) {
      // Swipe left = skip.
      await controls.start({ x: -600, rotate: -20, opacity: 0, transition: { duration: 0.35 } });
      onSkip(card, Math.abs(velocityX));
    } else {
      // Snap back.
      await controls.start({ x: 0, y: 0, rotate: 0, transition: { type: 'spring', stiffness: 300, damping: 20 } });
    }
  }

  return (
    <motion.div
      className="absolute inset-0"
      style={{
        x: isTop ? x : 0,
        y: isTop ? y : translateY,
        rotate: isTop ? rotate : 0,
        scale,
        zIndex: 10 - stackIndex
      }}
      animate={isTop ? controls : { scale, y: translateY }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
      drag={isTop ? true : false}
      dragConstraints={{ left: -300, right: 300, top: -300, bottom: 100 }}
      dragElastic={0.15}
      onDragEnd={isTop ? handleDragEnd : undefined}
    >
      {/* Swipe direction overlays (only on top card) */}
      {isTop && (
        <>
          <motion.div
            className="absolute top-8 left-6 z-20 px-4 py-1.5 rounded-xl border-4 border-green-400 text-green-400 font-black text-2xl tracking-widest rotate-[-20deg]"
            style={{ opacity: likeOpacity }}
          >
            LIKE
          </motion.div>
          <motion.div
            className="absolute top-8 right-6 z-20 px-4 py-1.5 rounded-xl border-4 border-red-400 text-red-400 font-black text-2xl tracking-widest rotate-[20deg]"
            style={{ opacity: skipOpacity }}
          >
            NOPE
          </motion.div>
          <motion.div
            className="absolute top-8 left-1/2 -translate-x-1/2 z-20 px-4 py-1.5 rounded-xl border-4 border-yellow-400 text-yellow-400 font-black text-2xl tracking-widest"
            style={{ opacity: superlikeOpacity }}
          >
            SUPER ⭐
          </motion.div>
        </>
      )}

      <VideoCard card={card} />
    </motion.div>
  );
}

// ─── SwipeStack ───────────────────────────────────────────────────────────────

export default function SwipeStack({
  cards: initialCards,
  onLike,
  onSkip,
  onSuperlike,
  onEmpty
}: SwipeStackProps) {
  const [cards, setCards] = useState<CardData[]>(initialCards);
  const dwellStart = useRef<number>(Date.now());

  const topCard = cards[0];
  const visibleCards = cards.slice(0, 3);

  function removeTopCard() {
    setCards((prev) => {
      const next = prev.slice(1);
      if (next.length === 0) onEmpty?.();
      return next;
    });
    dwellStart.current = Date.now();
  }

  function handleLike(card: CardData, velocity: number) {
    const dwellTimeMs = Date.now() - dwellStart.current;
    onLike?.({ ...card });
    console.debug('like', card.id, { dwellTimeMs, velocity });
    removeTopCard();
  }

  function handleSkip(card: CardData, velocity: number) {
    const dwellTimeMs = Date.now() - dwellStart.current;
    onSkip?.({ ...card });
    console.debug('skip', card.id, { dwellTimeMs, velocity });
    removeTopCard();
  }

  function handleSuperlike(card: CardData, velocity: number) {
    const dwellTimeMs = Date.now() - dwellStart.current;
    onSuperlike?.({ ...card });
    console.debug('superlike', card.id, { dwellTimeMs, velocity });
    removeTopCard();
  }

  if (!topCard) {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <p className="text-white/50 text-lg">No more cards 🎉</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full" style={{ perspective: 1000 }}>
      {/* Render up to 3 stacked cards, bottom to top */}
      {[...visibleCards].reverse().map((card, reversedIdx) => {
        const stackIndex = visibleCards.length - 1 - reversedIdx;
        return (
          <SwipeCard
            key={card.id}
            card={card}
            stackIndex={stackIndex}
            total={visibleCards.length}
            onLike={handleLike}
            onSkip={handleSkip}
            onSuperlike={handleSuperlike}
          />
        );
      })}

      {/* Action buttons */}
      <div className="absolute -bottom-16 inset-x-0 flex justify-center items-center gap-6 z-30">
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => handleSkip(topCard, 0)}
          className="w-14 h-14 rounded-full bg-white/10 border border-white/20 text-2xl flex items-center justify-center shadow-lg backdrop-blur-sm"
          aria-label="Skip"
        >
          ✕
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.15 }}
          whileTap={{ scale: 0.85 }}
          onClick={() => handleSuperlike(topCard, 0)}
          className="w-12 h-12 rounded-full bg-yellow-400/20 border border-yellow-400/50 text-xl flex items-center justify-center shadow-lg backdrop-blur-sm"
          aria-label="Superlike"
        >
          ⭐
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => handleLike(topCard, 0)}
          className="w-14 h-14 rounded-full bg-green-500/20 border border-green-500/50 text-2xl flex items-center justify-center shadow-lg backdrop-blur-sm"
          aria-label="Like"
        >
          ♥
        </motion.button>
      </div>
    </div>
  );
}
