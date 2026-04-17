'use client';

/**
 * MatchAnimation — explosive particle finale shown when two users match.
 *
 * Composition:
 *   1. Two avatar orbs fly in from the left and right edges on spring
 *      trajectories, colliding at the centre.
 *   2. At impact, a Canvas 2D particle burst is launched (≈ 160 sparks,
 *      each with its own velocity / hue / lifetime).
 *   3. A Web-Audio "ding" is synthesised directly in the browser — no asset
 *      download required — when the ringing sound preference is enabled.
 *   4. A confetti ring expands outward and fades to reveal the "IT'S A MATCH"
 *      headline plus two CTAs ("Say Hi", "Keep Swiping").
 *
 * Render contract:
 *   - Parent owns visibility. When `isOpen` transitions false → true, the
 *     component re-seeds its particle system and replays the entire sequence.
 *   - `onSayHi` and `onDismiss` are required callbacks.
 */

import {
  motion,
  AnimatePresence,
  useAnimationControls,
  type Variants
} from 'framer-motion';
import { useCallback, useEffect, useRef } from 'react';

export interface MatchedUser {
  userId: string;
  name: string;
  avatarUrl: string;
  accentColor: string; // tailwind-compatible rgba/hex
}

export interface MatchAnimationProps {
  isOpen: boolean;
  userA: MatchedUser;
  userB: MatchedUser;
  onSayHi: () => void;
  onDismiss: () => void;
  /** Mute the audio cue (e.g. accessibility or low-power mode). */
  muted?: boolean;
  /** Particle count — caps at 400 to keep 60 fps on mid-range phones. */
  particleCount?: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // remaining life in seconds
  maxLife: number;
  hue: number;
  radius: number;
}

const CENTER_VARIANTS: Variants = {
  initial: ({ fromLeft }: { fromLeft: boolean }) => ({
    x: fromLeft ? -280 : 280,
    y: 0,
    scale: 0.6,
    opacity: 0
  }),
  collide: {
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
    transition: { type: 'spring', stiffness: 240, damping: 22 }
  },
  exit: { scale: 0.6, opacity: 0, transition: { duration: 0.3 } }
};

export function seedParticles(count: number, width: number, height: number): Particle[] {
  const cx = width / 2;
  const cy = height / 2;
  const particles: Particle[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 180 + Math.random() * 520;
    const life = 0.7 + Math.random() * 1.1;
    particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      hue: 280 + Math.floor(Math.random() * 80),
      radius: 1.4 + Math.random() * 2.6
    });
  }
  return particles;
}

export function stepParticles(particles: Particle[], dt: number, gravity: number = 260): void {
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += gravity * dt;
    p.vx *= 0.985;
    p.life -= dt;
  }
}

function playDing(muted: boolean): void {
  if (muted) return;
  if (typeof window === 'undefined') return;
  const AudioCtx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;

  try {
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.42);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.7);
    osc.onended = () => ctx.close().catch(() => undefined);
  } catch {
    // Audio context failed (e.g. no user gesture) — silently degrade.
  }
}

export default function MatchAnimation({
  isOpen,
  userA,
  userB,
  onSayHi,
  onDismiss,
  muted = false,
  particleCount = 160
}: MatchAnimationProps) {
  const controlsA = useAnimationControls();
  const controlsB = useAnimationControls();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const particlesRef = useRef<Particle[]>([]);

  const startBurst = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const clamped = Math.min(Math.max(Math.floor(particleCount), 0), 400);
    particlesRef.current = seedParticles(clamped, width, height);

    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      stepParticles(particlesRef.current, dt);
      particlesRef.current = particlesRef.current.filter((p) => p.life > 0);

      ctx.clearRect(0, 0, width, height);
      for (const p of particlesRef.current) {
        const alpha = Math.max(0, p.life / p.maxLife);
        ctx.beginPath();
        ctx.fillStyle = `hsla(${p.hue}, 95%, 65%, ${alpha.toFixed(3)})`;
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      if (particlesRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(loop);
      } else {
        rafRef.current = null;
      }
    };

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(loop);
  }, [particleCount]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const run = async () => {
      await Promise.all([
        controlsA.start('initial', { duration: 0 }),
        controlsB.start('initial', { duration: 0 })
      ]);
      if (cancelled) return;
      await Promise.all([controlsA.start('collide'), controlsB.start('collide')]);
      if (cancelled) return;
      startBurst();
      playDing(muted);
    };

    void run();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isOpen, controlsA, controlsB, startBurst, muted]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/70 backdrop-blur-md"
          role="dialog"
          aria-live="polite"
        >
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0 h-full w-full"
            aria-hidden
          />

          <div className="relative flex items-center gap-6">
            <motion.div
              custom={{ fromLeft: true }}
              variants={CENTER_VARIANTS}
              initial="initial"
              animate={controlsA}
              exit="exit"
              className="relative flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-4"
              style={{ borderColor: userA.accentColor }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={userA.avatarUrl} alt={userA.name} className="h-full w-full object-cover" />
            </motion.div>

            <motion.span
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.5, type: 'spring', stiffness: 260 }}
              className="text-3xl font-light tracking-widest text-white"
            >
              ✦
            </motion.span>

            <motion.div
              custom={{ fromLeft: false }}
              variants={CENTER_VARIANTS}
              initial="initial"
              animate={controlsB}
              exit="exit"
              className="relative flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-4"
              style={{ borderColor: userB.accentColor }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={userB.avatarUrl} alt={userB.name} className="h-full w-full object-cover" />
            </motion.div>
          </div>

          <motion.h2
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8, duration: 0.5 }}
            className="mt-10 text-4xl font-semibold tracking-widest text-white"
          >
            IT’S A MATCH
          </motion.h2>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.0, duration: 0.5 }}
            className="mt-2 text-sm uppercase tracking-widest text-white/60"
          >
            {userA.name} · {userB.name}
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.15, duration: 0.4 }}
            className="mt-10 flex flex-col items-center gap-3"
          >
            <button
              onClick={onSayHi}
              className="rounded-full border border-white/30 bg-white px-7 py-3 text-sm font-semibold tracking-widest text-black"
            >
              SAY HI
            </button>
            <button
              onClick={onDismiss}
              className="rounded-full border border-white/10 bg-white/5 px-7 py-3 text-xs tracking-widest text-white/70"
            >
              KEEP SWIPING
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
