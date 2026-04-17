'use client';

/**
 * VideoCallScreen — full-screen WebRTC video call UI shown post-match.
 *
 * Composition:
 *   - Remote video fills the entire viewport (object-cover).
 *   - Self-view is a draggable picture-in-picture rectangle, constrained to
 *     the viewport. Parent passes its `MediaStream`; if absent we render a
 *     subtle placeholder tile.
 *   - A live call-duration timer ticks every second.
 *   - Connection quality indicator (green / yellow / red) is derived from
 *     the `stats` prop with a pure helper (`classifyQuality`) that is
 *     exported for unit-testing.
 *   - "End Call" and "Report" buttons sit centred at the bottom.
 *
 * The component is media-stream agnostic: parents pass actual `MediaStream`
 * instances plus a `stats` object. No direct `RTCPeerConnection` usage so
 * the component is easy to unit-test and to swap transports.
 */

import { motion, useDragControls } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface CallStats {
  /** Round-trip time in milliseconds. */
  rttMs: number;
  /** Packet loss percentage, 0-100. */
  packetLossPct: number;
  /** Current inbound bitrate in kbps. */
  inboundKbps: number;
}

export type CallQuality = 'excellent' | 'good' | 'fair' | 'poor';

export interface VideoCallScreenProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  peerName: string;
  peerAvatarUrl?: string;
  stats?: CallStats | null;
  onEndCall: () => void;
  onReport: () => void;
  /** Optional fixed "now" function for deterministic tests. */
  now?: () => number;
}

/**
 * Pure classifier — map raw WebRTC stats to a qualitative quality label.
 * Thresholds are tuned for conversational video (not 4K streaming).
 */
export function classifyQuality(stats: CallStats | null | undefined): CallQuality {
  if (!stats) return 'fair';
  const { rttMs, packetLossPct, inboundKbps } = stats;

  if (rttMs < 120 && packetLossPct < 1 && inboundKbps > 600) return 'excellent';
  if (rttMs < 220 && packetLossPct < 3 && inboundKbps > 350) return 'good';
  if (rttMs < 400 && packetLossPct < 8 && inboundKbps > 150) return 'fair';
  return 'poor';
}

/** Pure formatter — seconds → mm:ss or h:mm:ss. */
export function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const QUALITY_COLOR: Record<CallQuality, string> = {
  excellent: 'bg-emerald-400',
  good: 'bg-emerald-300',
  fair: 'bg-amber-400',
  poor: 'bg-rose-500'
};

const QUALITY_LABEL: Record<CallQuality, string> = {
  excellent: 'EXCELLENT',
  good: 'GOOD',
  fair: 'FAIR',
  poor: 'POOR'
};

export default function VideoCallScreen({
  localStream,
  remoteStream,
  peerName,
  peerAvatarUrl,
  stats,
  onEndCall,
  onReport,
  now
}: VideoCallScreenProps) {
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragControls = useDragControls();
  const [startedAt] = useState(() => (now ? now() : Date.now()));
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const el = remoteVideoRef.current;
    if (!el) return;
    if (remoteStream) {
      el.srcObject = remoteStream;
    } else {
      el.srcObject = null;
    }
  }, [remoteStream]);

  useEffect(() => {
    const el = localVideoRef.current;
    if (!el) return;
    if (localStream) {
      el.srcObject = localStream;
    } else {
      el.srcObject = null;
    }
  }, [localStream]);

  useEffect(() => {
    const tick = () => setElapsedMs((now ? now() : Date.now()) - startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, now]);

  const quality = useMemo(() => classifyQuality(stats ?? null), [stats]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-40 bg-black text-white"
      aria-label={`Call with ${peerName}`}
    >
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
      />

      {!remoteStream && peerAvatarUrl && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gradient-to-b from-neutral-900 to-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={peerAvatarUrl}
            alt={peerName}
            className="h-28 w-28 rounded-full border-2 border-white/20 object-cover"
          />
          <span className="text-sm uppercase tracking-widest text-white/70">Connecting…</span>
        </div>
      )}

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-5 pt-safe pb-6">
        <div className="flex items-center gap-3">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${QUALITY_COLOR[quality]}`} />
          <span className="text-[11px] uppercase tracking-widest text-white/70">
            {QUALITY_LABEL[quality]}
          </span>
        </div>
        <div className="text-sm font-mono tracking-wide" aria-label="call-duration">
          {formatDuration(elapsedMs / 1000)}
        </div>
      </div>

      {/* Self-view PiP */}
      <motion.div
        drag
        dragControls={dragControls}
        dragMomentum={false}
        dragConstraints={containerRef}
        dragElastic={0.05}
        initial={{ x: 0, y: 0 }}
        className="absolute bottom-28 right-5 h-40 w-28 cursor-grab overflow-hidden rounded-xl border border-white/20 bg-neutral-900 shadow-2xl active:cursor-grabbing"
        aria-label="self-view"
      >
        {localStream ? (
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full scale-x-[-1] object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-widest text-white/40">
            No camera
          </div>
        )}
      </motion.div>

      {/* Bottom controls */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-4 bg-gradient-to-t from-black/70 to-transparent px-5 pb-10 pt-16">
        <button
          onClick={onReport}
          className="rounded-full border border-white/20 bg-white/10 px-6 py-3 text-xs tracking-widest text-white/80"
        >
          REPORT
        </button>
        <button
          onClick={onEndCall}
          className="rounded-full bg-rose-500 px-8 py-3 text-xs font-semibold tracking-widest text-white shadow-lg shadow-rose-500/40"
        >
          END CALL
        </button>
      </div>
    </div>
  );
}
