'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';

type ScanPhase = 'idle' | 'scanning' | 'verifying' | 'success';

export default function LoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [error, setError] = useState('');

  const handleScan = async () => {
    setError('');
    setPhase('scanning');
    try {
      // Simulate biometric scan (1.4 s)
      await delay(1400);
      setPhase('verifying');
      // Simulate Quantmail identity verification (1.0 s)
      await delay(1000);
      setPhase('success');
      await delay(600);
      router.push('/dashboard');
    } catch {
      setPhase('idle');
      setError('Authentication failed. Please try again.');
    }
  };

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-midnight px-6">
      {/* Ambient background blobs */}
      <AmbientBlobs />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.2, ease: 'easeOut' }}
        className="relative z-10 flex flex-col items-center gap-10 text-center"
      >
        {/* Logo / Brand */}
        <div className="flex flex-col items-center gap-3">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
            className="h-14 w-14 rounded-full border border-aurora/40 bg-gradient-to-br from-aurora/20 to-teal/10 backdrop-blur-sm"
          />
          <h1 className="text-3xl font-light tracking-widest text-fog text-glow-aurora">
            QUANTCHILL
          </h1>
          <p className="text-sm font-light tracking-wider text-fog/50">
            Immersive Relaxation Hub · Quant Ecosystem
          </p>
        </div>

        {/* Biometric scan ring */}
        <BiometricRing phase={phase} onScan={handleScan} />

        {/* Status text */}
        <AnimatePresence mode="wait">
          <motion.p
            key={phase}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.5 }}
            className="text-xs tracking-widest text-fog/60"
          >
            {statusLabel(phase)}
          </motion.p>
        </AnimatePresence>

        {/* Quantmail identity badge */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: phase === 'idle' ? 1 : 0 }}
          className="flex items-center gap-2 rounded-full border border-white/5 bg-white/5 px-4 py-1.5 backdrop-blur-sm"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-teal-glow" />
          <span className="text-xs font-light text-fog/70 tracking-wider">
            Quantmail SSO active
          </span>
        </motion.div>

        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}
      </motion.div>
    </main>
  );
}

/* ─── Biometric Ring ─────────────────────────────────────────────────────── */
function BiometricRing({
  phase,
  onScan,
}: {
  phase: ScanPhase;
  onScan: () => void;
}) {
  const isActive = phase !== 'idle';

  return (
    <div className="relative flex items-center justify-center">
      {/* Outer pulse ring */}
      <AnimatePresence>
        {isActive && (
          <motion.span
            key="pulse"
            initial={{ scale: 0.8, opacity: 0.8 }}
            animate={{ scale: 1.6, opacity: 0 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
            className="absolute h-36 w-36 rounded-full border border-aurora/50"
          />
        )}
      </AnimatePresence>

      {/* Mid ring */}
      <motion.div
        animate={
          isActive
            ? { rotate: 360 }
            : { rotate: 0 }
        }
        transition={
          isActive
            ? { duration: 3, repeat: Infinity, ease: 'linear' }
            : { duration: 0.4 }
        }
        className="absolute h-28 w-28 rounded-full border border-dashed border-aurora/30"
      />

      {/* Inner circle / button */}
      <motion.button
        onClick={phase === 'idle' ? onScan : undefined}
        disabled={isActive}
        whileHover={phase === 'idle' ? { scale: 1.06 } : {}}
        whileTap={phase === 'idle' ? { scale: 0.96 } : {}}
        animate={
          phase === 'success'
            ? { scale: [1, 1.1, 1], backgroundColor: '#0e9999' }
            : {}
        }
        transition={{ duration: 0.6 }}
        className={[
          'relative z-10 flex h-24 w-24 cursor-pointer flex-col items-center justify-center rounded-full',
          'border border-aurora/40 bg-gradient-to-br from-aurora/20 to-teal/10',
          'backdrop-blur-md transition-all duration-500',
          'focus:outline-none glow-aurora',
          isActive ? 'cursor-default' : '',
        ].join(' ')}
      >
        <AnimatePresence mode="wait">
          {phase === 'idle' && (
            <motion.span
              key="icon-idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-2xl"
            >
              ☊
            </motion.span>
          )}
          {(phase === 'scanning' || phase === 'verifying') && (
            <motion.span
              key="icon-scan"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.2, repeat: Infinity }}
              className="text-2xl"
            >
              ◌
            </motion.span>
          )}
          {phase === 'success' && (
            <motion.span
              key="icon-ok"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20 }}
              className="text-2xl"
            >
              ✓
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
    </div>
  );
}

/* ─── Ambient Blobs ──────────────────────────────────────────────────────── */
function AmbientBlobs() {
  return (
    <>
      <motion.div
        animate={{ x: [0, 30, 0], y: [0, -20, 0] }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
        className="pointer-events-none absolute left-1/4 top-1/3 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full bg-aurora/10 blur-3xl"
      />
      <motion.div
        animate={{ x: [0, -25, 0], y: [0, 18, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
        className="pointer-events-none absolute right-1/4 bottom-1/3 h-72 w-72 rounded-full bg-teal/10 blur-3xl"
      />
    </>
  );
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function statusLabel(phase: ScanPhase) {
  switch (phase) {
    case 'idle':
      return 'TAP TO AUTHENTICATE';
    case 'scanning':
      return 'READING BIOMETRIC SIGNATURE …';
    case 'verifying':
      return 'VERIFYING WITH QUANTMAIL IDENTITY …';
    case 'success':
      return 'IDENTITY CONFIRMED';
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
