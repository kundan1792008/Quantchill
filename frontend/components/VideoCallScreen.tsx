'use client';

import { motion, useDragControls } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';

/** Discrete connection quality bands used by the indicator dot. */
export type ConnectionQuality = 'good' | 'fair' | 'poor';

/** Props for the video call screen. */
export interface VideoCallScreenProps {
  /** Remote peer media stream (nullable while connecting). */
  remoteStream?: MediaStream | null;
  /** Local camera stream for the self-view PiP. */
  localStream?: MediaStream | null;
  /** Remote peer's display name. */
  peerName: string;
  /** Connection quality – re-measured by the caller from WebRTC stats. */
  connectionQuality?: ConnectionQuality;
  /** Called when the user taps "End Call". */
  onEndCall?: () => void;
  /** Called when the user taps "Report". */
  onReport?: () => void;
}

/**
 * Derive the current call duration (ms) from a single "call started" timestamp.
 * Rendered as MM:SS in the top bar.
 */
function useCallTimer(startedAt: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Full-screen post-match video call UI.
 *
 * Layout:
 *   - Remote video fills the viewport.
 *   - A draggable PiP self-view sits in the bottom-right (constrained to the
 *     viewport so the user cannot drag it off-screen).
 *   - Top bar: peer name + duration timer + coloured quality dot.
 *   - Bottom bar: "End Call" (red) and "Report" (subtle) buttons.
 */
export default function VideoCallScreen({
  remoteStream,
  localStream,
  peerName,
  connectionQuality = 'good',
  onEndCall,
  onReport
}: VideoCallScreenProps) {
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragControls = useDragControls();
  const startedAt = useMemo(() => Date.now(), []);
  const duration = useCallTimer(startedAt);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  const qualityClass =
    connectionQuality === 'good'
      ? 'bg-emerald-400 shadow-[0_0_12px_2px_rgba(52,211,153,0.7)]'
      : connectionQuality === 'fair'
      ? 'bg-amber-400 shadow-[0_0_12px_2px_rgba(250,204,21,0.7)]'
      : 'bg-rose-500 shadow-[0_0_12px_2px_rgba(244,63,94,0.7)]';

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-40 flex flex-col bg-black text-fog"
      role="region"
      aria-label={`Video call with ${peerName}`}
    >
      {/* Remote video (full screen) */}
      {remoteStream ? (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-aurora/20 via-midnight to-black">
          <p className="text-sm tracking-widest text-fog/60">CONNECTING …</p>
        </div>
      )}

      {/* Top bar */}
      <div className="relative z-10 flex items-center justify-between gap-4 bg-gradient-to-b from-black/70 to-transparent px-5 py-4">
        <div className="flex items-center gap-3">
          <span
            aria-label={`connection-${connectionQuality}`}
            className={`h-2.5 w-2.5 rounded-full ${qualityClass}`}
          />
          <div>
            <p className="text-base font-medium">{peerName}</p>
            <p className="text-[11px] uppercase tracking-widest text-fog/60">{connectionQuality}</p>
          </div>
        </div>
        <p className="font-mono text-sm tracking-wider text-fog/80" aria-label="call duration">
          {duration}
        </p>
      </div>

      <div className="relative flex-1" />

      {/* Bottom action bar */}
      <div className="relative z-10 flex items-center justify-center gap-6 bg-gradient-to-t from-black/80 to-transparent px-6 py-6">
        <button
          type="button"
          onClick={onReport}
          className="rounded-full border border-white/20 px-5 py-2 text-xs uppercase tracking-widest text-fog/80 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-aurora"
        >
          Report
        </button>
        <button
          type="button"
          onClick={onEndCall}
          className="rounded-full bg-rose-500 px-6 py-3 text-sm font-semibold uppercase tracking-widest text-white shadow-lg shadow-rose-500/40 hover:bg-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
        >
          End Call
        </button>
      </div>

      {/* Draggable self-view PiP */}
      <motion.div
        drag
        dragControls={dragControls}
        dragMomentum={false}
        dragConstraints={containerRef}
        dragElastic={0.15}
        initial={{ x: 0, y: 0 }}
        className="absolute bottom-24 right-5 z-20 h-40 w-28 cursor-grab overflow-hidden rounded-2xl border border-white/20 bg-black shadow-xl active:cursor-grabbing"
        aria-label="self-view"
      >
        {localStream ? (
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-teal/30 to-midnight text-[10px] tracking-widest text-fog/70">
            CAMERA OFF
          </div>
        )}
      </motion.div>
    </div>
  );
}
