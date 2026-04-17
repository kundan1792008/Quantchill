'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MatchAnimationProps {
  userAvatar?: string;
  matchAvatar?: string;
  userName?: string;
  matchName?: string;
  onDismiss?: () => void;
  /** Duration in ms before the animation auto-dismisses. Default: 4000. */
  autoDismissMs?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PARTICLE_COUNT = 80;
const CANVAS_SIZE = 400;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  alpha: number;
  decay: number;
}

const PARTICLE_COLORS = [
  '#f97316', '#facc15', '#4ade80', '#60a5fa',
  '#c084fc', '#fb7185', '#34d399', '#fbbf24'
];

// ─── Canvas confetti renderer ─────────────────────────────────────────────────

function spawnParticles(cx: number, cy: number): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 8;
    return {
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 2 + Math.random() * 5,
      color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)]!,
      alpha: 1,
      decay: 0.012 + Math.random() * 0.018
    };
  });
}

function useCanvasAnimation(active: boolean) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cx = CANVAS_SIZE / 2;
    const cy = CANVAS_SIZE / 2;
    particlesRef.current = spawnParticles(cx, cy);

    function draw() {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particlesRef.current = particlesRef.current.filter((p) => p.alpha > 0.01);

      for (const p of particlesRef.current) {
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.12; // gravity
        p.vx *= 0.98;  // drag
        p.alpha -= p.decay;
      }

      if (particlesRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(draw);
      }
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active]);

  return canvasRef;
}

// ─── Web Audio API "match" chime ──────────────────────────────────────────────

function playMatchSound() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6

    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      const start = ctx.currentTime + i * 0.1;
      gain.gain.setValueAtTime(0.18, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
      osc.start(start);
      osc.stop(start + 0.45);
    });
  } catch {
    // Web Audio not available (SSR or restricted environment).
  }
}

// ─── Avatar component ─────────────────────────────────────────────────────────

function Avatar({ src, name, delay }: { src?: string; name?: string; delay: number }) {
  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 18, delay }}
      className="w-28 h-28 rounded-full overflow-hidden border-4 border-white/30 bg-white/10 flex items-center justify-center shadow-xl"
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name ?? 'avatar'} className="w-full h-full object-cover" />
      ) : (
        <span className="text-5xl">👤</span>
      )}
    </motion.div>
  );
}

// ─── MatchAnimation ───────────────────────────────────────────────────────────

export default function MatchAnimation({
  userAvatar,
  matchAvatar,
  userName = 'You',
  matchName = 'Match',
  onDismiss,
  autoDismissMs = 4000
}: MatchAnimationProps) {
  const [visible, setVisible] = useState(true);
  const canvasRef = useCanvasAnimation(visible);

  const dismiss = useCallback(() => {
    setVisible(false);
    onDismiss?.();
  }, [onDismiss]);

  // Auto-dismiss.
  useEffect(() => {
    if (!visible) return;
    playMatchSound();
    const timer = setTimeout(dismiss, autoDismissMs);
    return () => clearTimeout(timer);
  }, [visible, autoDismissMs, dismiss]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md"
          onClick={dismiss}
        >
          {/* Particle canvas (centred behind avatars) */}
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="absolute pointer-events-none"
            style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
          />

          {/* "It's a Match!" headline */}
          <motion.h1
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.15, type: 'spring', stiffness: 200, damping: 18 }}
            className="relative text-5xl font-black tracking-tight text-white mb-10 drop-shadow-lg"
            style={{ textShadow: '0 0 30px #a78bfa88' }}
          >
            It&apos;s a Match! 🎉
          </motion.h1>

          {/* Avatars flying toward each other */}
          <div className="relative flex items-center justify-center gap-6">
            <motion.div
              initial={{ x: -80, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.3, type: 'spring', stiffness: 180, damping: 16 }}
              className="flex flex-col items-center gap-2"
            >
              <Avatar src={userAvatar} name={userName} delay={0} />
              <span className="text-white/80 text-sm font-medium">{userName}</span>
            </motion.div>

            {/* Heart between avatars */}
            <motion.div
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: [0, 1.4, 1], rotate: [0, 15, 0] }}
              transition={{ delay: 0.55, duration: 0.5, ease: 'easeOut' }}
              className="text-4xl"
            >
              💜
            </motion.div>

            <motion.div
              initial={{ x: 80, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.3, type: 'spring', stiffness: 180, damping: 16 }}
              className="flex flex-col items-center gap-2"
            >
              <Avatar src={matchAvatar} name={matchName} delay={0.1} />
              <span className="text-white/80 text-sm font-medium">{matchName}</span>
            </motion.div>
          </div>

          {/* CTA */}
          <motion.button
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.7, type: 'spring', stiffness: 200, damping: 18 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={(e) => { e.stopPropagation(); dismiss(); }}
            className="mt-10 px-8 py-3 rounded-full bg-gradient-to-r from-violet-500 to-pink-500 text-white font-bold text-lg shadow-xl"
          >
            Start Video Call 📹
          </motion.button>

          <p className="mt-4 text-white/30 text-xs">Tap anywhere to dismiss</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
