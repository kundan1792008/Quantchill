'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import type { ChillRoomFriend, MoodState } from '@/lib/mockData';
import { MOODS } from '@/lib/mockData';

interface ChillRoomLobbyProps {
  friends: ChillRoomFriend[];
}

const MOOD_BADGE: Record<MoodState, string> = {
  'deep-focus': 'bg-aurora/20 text-aurora-light border-aurora/30',
  relaxation: 'bg-teal/20 text-teal-glow border-teal/30',
  sleep: 'bg-blue-900/30 text-blue-300 border-blue-700/40',
};

export default function ChillRoomLobby({ friends }: ChillRoomLobbyProps) {
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  const handleJoin = () => {
    setJoining(true);
    new Promise<void>((resolve) => setTimeout(resolve, 1200))
      .then(() => {
        setJoining(false);
        setJoined(true);
      })
      .catch(() => {
        setJoining(false);
      });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, delay: 0.3 }}
      className="flex flex-col gap-4 rounded-2xl border border-white/5 bg-white/[0.03] p-5 backdrop-blur-sm"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🌌</span>
          <h2 className="text-sm font-medium tracking-wider text-fog/80">
            CHILL ROOMS
          </h2>
        </div>
        <span className="flex items-center gap-1 text-xs text-fog/40">
          <span className="h-1.5 w-1.5 rounded-full bg-teal-glow animate-pulse-slow" />
          {friends.length} online
        </span>
      </div>

      {/* Friend list */}
      <div className="flex flex-col gap-2">
        <AnimatePresence>
          {friends.map((friend, i) => (
            <motion.div
              key={friend.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 * i, duration: 0.5 }}
              className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-2.5"
            >
              {/* Avatar */}
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-xl">
                {friend.avatar}
              </span>

              {/* Info */}
              <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium text-fog/90 truncate">
                  {friend.name}
                </span>
                <span className="text-xs text-fog/40 truncate">
                  {friend.frequency}
                </span>
              </div>

              {/* Mood badge */}
              <span
                className={[
                  'rounded-full border px-2 py-0.5 text-[10px] tracking-wider whitespace-nowrap',
                  MOOD_BADGE[friend.mood],
                ].join(' ')}
              >
                {MOODS[friend.mood].emoji} {MOODS[friend.mood].label}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Join 3D Room button */}
      <motion.button
        onClick={joined ? undefined : handleJoin}
        disabled={joining || joined}
        whileHover={!joined && !joining ? { scale: 1.02 } : {}}
        whileTap={!joined && !joining ? { scale: 0.98 } : {}}
        className={[
          'relative mt-1 flex items-center justify-center gap-2 rounded-xl py-3 text-sm tracking-widest',
          'border transition-all duration-700 focus:outline-none',
          joined
            ? 'border-teal/40 bg-teal/10 text-teal-glow glow-teal'
            : joining
            ? 'border-aurora/30 bg-aurora/10 text-aurora-light cursor-wait'
            : 'border-aurora/40 bg-aurora/10 text-aurora-light hover:border-aurora/60 hover:bg-aurora/15',
        ].join(' ')}
      >
        <AnimatePresence mode="wait">
          {joining ? (
            <motion.span
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1, repeat: Infinity }}
              className="flex items-center gap-2"
            >
              <span className="animate-spin-slow">◌</span>
              ENTERING DIMENSION …
            </motion.span>
          ) : joined ? (
            <motion.span
              key="joined"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="flex items-center gap-2"
            >
              ✦ YOU&apos;RE IN THE ROOM
            </motion.span>
          ) : (
            <motion.span
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-2"
            >
              <span>⬡</span> JOIN 3D ROOM
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      {joined && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center text-[10px] tracking-wider text-fog/30"
        >
          Handoff to Godot WebXR · preparing immersive space
        </motion.p>
      )}
    </motion.div>
  );
}
