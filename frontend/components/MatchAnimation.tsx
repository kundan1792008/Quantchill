'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

/**
 * Match explosion animation.
 *
 * When two users match, two avatars fly toward the centre of the screen and
 * collide, triggering a canvas-driven confetti / spark particle burst. A short
 * Web Audio API sine sweep plays as the "match" SFX.
 *
 * The caller controls the lifecycle by mounting/unmounting the component. When
 * mounted, the animation plays once and calls `onComplete` after
 * `durationMs` milliseconds (default 2400).
 */
export interface MatchAnimationProps {
  leftAvatarUrl?: string;
  rightAvatarUrl?: string;
  leftName?: string;
  rightName?: string;
  durationMs?: number;
  soundEnabled?: boolean;
  onComplete?: () => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  hue: number;
  size: number;
}

const PARTICLE_COUNT = 140;

export default function MatchAnimation({
  leftAvatarUrl,
  rightAvatarUrl,
  leftName = 'You',
  rightName = 'Match',
  durationMs = 2400,
  soundEnabled = true,
  onComplete
}: MatchAnimationProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const particles: Particle[] = [];
    let collided = false;
    const startedAt = performance.now();
    const collisionAt = 900; // ms into the animation

    function spawnParticles(cx: number, cy: number) {
      for (let i = 0; i < PARTICLE_COUNT; i += 1) {
        const angle = (Math.PI * 2 * i) / PARTICLE_COUNT + Math.random() * 0.4;
        const speed = 2 + Math.random() * 5;
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife: 60 + Math.random() * 40,
          hue: Math.floor(180 + Math.random() * 160),
          size: 2 + Math.random() * 3
        });
      }
    }

    let rafId = 0;
    function frame() {
      const now = performance.now();
      const elapsed = now - startedAt;
      const rect = canvas!.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;

      ctx!.clearRect(0, 0, rect.width, rect.height);

      if (!collided && elapsed >= collisionAt) {
        collided = true;
        spawnParticles(cx, cy);
      }

      if (collided) {
        for (const p of particles) {
          p.life += 1;
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.08; // gravity
          p.vx *= 0.99;
          p.vy *= 0.99;
          const alpha = Math.max(0, 1 - p.life / p.maxLife);
          ctx!.fillStyle = `hsla(${p.hue}, 95%, 65%, ${alpha.toFixed(3)})`;
          ctx!.beginPath();
          ctx!.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx!.fill();
        }
      }

      if (elapsed < durationMs) {
        rafId = requestAnimationFrame(frame);
      } else {
        onComplete?.();
      }
    }
    rafId = requestAnimationFrame(frame);

    // Sound effect – Web Audio API short sine sweep.
    let audioCtx: AudioContext | null = null;
    if (soundEnabled && typeof window !== 'undefined') {
      try {
        type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };
        const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
        if (Ctor) {
          audioCtx = new Ctor();
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(440, audioCtx.currentTime);
          osc.frequency.linearRampToValueAtTime(880, audioCtx.currentTime + 0.25);
          gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.6);
          osc.connect(gain).connect(audioCtx.destination);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.7);
        }
      } catch {
        audioCtx = null;
      }
    }

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      if (audioCtx) {
        audioCtx.close().catch(() => undefined);
      }
    };
  }, [durationMs, onComplete, soundEnabled]);

  return (
    <div
      role="dialog"
      aria-label="match-animation"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Avatars flying toward the centre */}
      <div className="relative flex h-40 w-full max-w-md items-center justify-center">
        <motion.div
          initial={{ x: '-120%', opacity: 0, scale: 0.7 }}
          animate={{ x: '-10%', opacity: 1, scale: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 22 }}
          className="relative z-10"
        >
          <AvatarBubble src={leftAvatarUrl} name={leftName} />
        </motion.div>
        <motion.div
          initial={{ x: '120%', opacity: 0, scale: 0.7 }}
          animate={{ x: '10%', opacity: 1, scale: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 22 }}
          className="relative z-10"
        >
          <AvatarBubble src={rightAvatarUrl} name={rightName} />
        </motion.div>
      </div>

      {/* Banner */}
      <motion.h2
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.0, duration: 0.6 }}
        className="absolute bottom-24 text-4xl font-light tracking-[0.3em] text-fog text-glow-aurora"
      >
        IT&apos;S A MATCH
      </motion.h2>
    </div>
  );
}

function AvatarBubble({ src, name }: { src?: string; name: string }) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className="h-28 w-28 rounded-full border-4 border-aurora/60 object-cover shadow-xl"
      />
    );
  }
  return (
    <div
      aria-label={name}
      className="flex h-28 w-28 items-center justify-center rounded-full border-4 border-aurora/60 bg-gradient-to-br from-aurora/40 to-teal/30 text-2xl font-semibold text-fog shadow-xl"
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
