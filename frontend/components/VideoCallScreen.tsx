'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConnectionQuality = 'good' | 'medium' | 'poor' | 'disconnected';

export interface VideoCallScreenProps {
  /** Remote user's name. */
  remoteName?: string;
  /** Remote MediaStream (WebRTC). Null while connecting. */
  remoteStream?: MediaStream | null;
  /** Local MediaStream for the self-view PiP. */
  localStream?: MediaStream | null;
  /** Current connection quality indicator. */
  connectionQuality?: ConnectionQuality;
  onEndCall?: () => void;
  onReport?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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

// ─── VideoElement helper ──────────────────────────────────────────────────────

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

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={className}
    />
  );
}

// ─── Draggable PiP (self-view) ────────────────────────────────────────────────

function SelfViewPiP({ localStream }: { localStream?: MediaStream | null }) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    isDragging.current = true;
    dragStart.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDragging.current) return;
    setPos({
      x: dragStart.current.px + (e.clientX - dragStart.current.mx),
      y: dragStart.current.py + (e.clientY - dragStart.current.my)
    });
  }

  function onPointerUp() {
    isDragging.current = false;
  }

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

// ─── VideoCallScreen ──────────────────────────────────────────────────────────

export default function VideoCallScreen({
  remoteName = 'Unknown',
  remoteStream,
  localStream,
  connectionQuality = 'good',
  onEndCall,
  onReport
}: VideoCallScreenProps) {
  const [elapsed, setElapsed] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [showReportConfirm, setShowReportConfirm] = useState(false);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Call timer.
  useEffect(() => {
    const interval = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-hide controls after 4 seconds of inactivity.
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 4000);
  }, []);

  useEffect(() => {
    resetControlsTimer();
    return () => clearTimeout(controlsTimerRef.current);
  }, [resetControlsTimer]);

  function handleReport() {
    if (!showReportConfirm) {
      setShowReportConfirm(true);
      return;
    }
    setShowReportConfirm(false);
    onReport?.();
  }

  const qualityColor = QUALITY_COLORS[connectionQuality];
  const qualityLabel = QUALITY_LABELS[connectionQuality];

  return (
    <div
      className="relative w-full h-full bg-black overflow-hidden"
      onClick={resetControlsTimer}
      onPointerMove={resetControlsTimer}
    >
      {/* Remote video (full screen) */}
      {remoteStream ? (
        <VideoElement
          stream={remoteStream}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          <div className="text-6xl animate-pulse">📡</div>
          <p className="text-white/60 text-lg">Connecting to {remoteName}…</p>
        </div>
      )}

      {/* Top HUD */}
      <AnimatePresence>
        {showControls && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.25 }}
            className="absolute top-0 inset-x-0 z-20 flex items-center justify-between px-5 pt-safe-top py-4 bg-gradient-to-b from-black/60 to-transparent"
          >
            {/* Remote name */}
            <div className="flex items-center gap-2">
              <span className="text-white font-semibold text-lg">{remoteName}</span>
            </div>

            {/* Timer */}
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-black/40 backdrop-blur-sm">
              <span className="text-white/80 text-sm font-mono">{formatDuration(elapsed)}</span>
            </div>

            {/* Connection quality */}
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-black/40 backdrop-blur-sm">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: qualityColor, boxShadow: `0 0 6px ${qualityColor}` }}
              />
              <span className="text-white/70 text-xs">{qualityLabel}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Self-view PiP */}
      <SelfViewPiP localStream={localStream} />

      {/* Bottom controls */}
      <AnimatePresence>
        {showControls && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.25 }}
            className="absolute bottom-0 inset-x-0 z-20 flex items-center justify-center gap-6 pb-safe-bottom py-6 bg-gradient-to-t from-black/70 to-transparent"
          >
            {/* Report button */}
            <motion.button
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              onClick={handleReport}
              className={[
                'w-12 h-12 rounded-full flex items-center justify-center shadow-xl text-xl',
                showReportConfirm
                  ? 'bg-orange-500/80 border-2 border-orange-400'
                  : 'bg-white/10 border border-white/20 backdrop-blur-sm'
              ].join(' ')}
              aria-label={showReportConfirm ? 'Confirm report' : 'Report user'}
              title={showReportConfirm ? 'Tap again to confirm report' : 'Report user'}
            >
              {showReportConfirm ? '⚠️' : '🚩'}
            </motion.button>

            {/* End call button */}
            <motion.button
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              onClick={onEndCall}
              className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-xl text-2xl border-2 border-red-400"
              aria-label="End call"
            >
              📵
            </motion.button>

            {/* Placeholder spacer to balance layout */}
            <div className="w-12 h-12" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Report confirmation overlay */}
      <AnimatePresence>
        {showReportConfirm && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="absolute inset-x-4 bottom-28 z-40 rounded-2xl bg-black/90 border border-white/10 p-4 text-center shadow-2xl backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-white font-semibold mb-1">Report {remoteName}?</p>
            <p className="text-white/50 text-xs mb-3">
              After 3 reports, users are automatically banned.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowReportConfirm(false)}
                className="flex-1 py-2 rounded-xl bg-white/10 text-white text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleReport}
                className="flex-1 py-2 rounded-xl bg-orange-500 text-white text-sm font-semibold"
              >
                Report
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
