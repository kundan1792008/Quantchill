'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Image from 'next/image';

export interface DiscoveryCandidate {
  id: string;
  displayName: string;
  headline?: string;
  interests: string[];
  /** Predicted long-form compatibility signal in [0, 100]. */
  compatibilityScore: number;
  /** Recency or freshness signal in [0, 1]. */
  freshness: number;
  /** Optional media URL for card background. */
  mediaUrl?: string;
}

export interface DiscoveryFeedProps {
  initialCandidates: DiscoveryCandidate[];
  loadMore: (cursor: string | null) => Promise<DiscoveryCandidate[]>;
  /** Trigger prefetch when this many cards remain in the local buffer. */
  prefetchThreshold?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function scoreCandidate(candidate: DiscoveryCandidate, momentum: number): number {
  const compatibility = clamp(candidate.compatibilityScore / 100, 0, 1);
  const freshness = clamp(candidate.freshness, 0, 1);
  const interestBreadth = clamp(candidate.interests.length / 8, 0, 1);

  // Predictive sequencing:
  // - compatibility anchors relevance
  // - freshness keeps feed dynamic
  // - momentum reduces repeated low-interest cards in a row
  return compatibility * 0.62 + freshness * 0.23 + interestBreadth * 0.1 + momentum * 0.05;
}

function reorderForContinuity(candidates: DiscoveryCandidate[], engagementMomentum: number): DiscoveryCandidate[] {
  const scored = candidates.map((candidate, index) => {
    const entropyPenalty = (index % 3) * 0.008;
    return {
      candidate,
      score: scoreCandidate(candidate, engagementMomentum) - entropyPenalty
    };
  });

  scored.sort((left, right) => right.score - left.score);
  return scored.map((entry) => entry.candidate);
}

export default function DiscoveryFeed({
  initialCandidates,
  loadMore,
  prefetchThreshold = 4
}: DiscoveryFeedProps) {
  const [queue, setQueue] = useState<DiscoveryCandidate[]>(() => reorderForContinuity(initialCandidates, 0.5));
  const [cursor, setCursor] = useState<string | null>(
    initialCandidates.length > 0 ? initialCandidates[initialCandidates.length - 1]!.id : null
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [engagementMomentum, setEngagementMomentum] = useState(0.5);

  const loadLock = useRef<Promise<void> | null>(null);

  const visible = useMemo(() => queue.slice(activeIndex, activeIndex + 3), [queue, activeIndex]);

  const prefetchIfNeeded = useCallback(async () => {
    const remaining = queue.length - activeIndex;
    if (remaining > prefetchThreshold || isLoading) return;
    if (loadLock.current) return;

    loadLock.current = (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const next = await loadMore(cursor);
        if (next.length > 0) {
          const last = next[next.length - 1];
          setCursor(last?.id ?? cursor);
          setQueue((previous) => {
            const unconsumed = previous.slice(activeIndex);
            const merged = [...unconsumed, ...next];
            return reorderForContinuity(merged, engagementMomentum);
          });
          setActiveIndex(0);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load additional candidates');
      } finally {
        setIsLoading(false);
        loadLock.current = null;
      }
    })();

    await loadLock.current;
  }, [activeIndex, cursor, engagementMomentum, isLoading, loadMore, prefetchThreshold, queue]);

  useEffect(() => {
    void prefetchIfNeeded();
  }, [prefetchIfNeeded]);

  const consumeCard = useCallback(
    (signal: 'skip' | 'like' | 'super') => {
      setEngagementMomentum((current) => {
        const delta = signal === 'super' ? 0.18 : signal === 'like' ? 0.08 : -0.12;
        return clamp(current + delta, 0.1, 1);
      });

      setActiveIndex((index) => Math.min(index + 1, Math.max(0, queue.length - 1)));
    },
    [queue.length]
  );

  const active = visible[0];

  return (
    <section className="flex w-full max-w-xl flex-col gap-3 rounded-2xl border border-white/10 bg-black/25 p-4 text-fog backdrop-blur-sm">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-wide">Discovery Feed</h2>
          <p className="text-[11px] text-fog/60">Predictive compatibility sequencing · seamless loading</p>
        </div>
        <span className="rounded-full border border-aurora/30 bg-aurora/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-aurora">
          {Math.round(engagementMomentum * 100)}% momentum
        </span>
      </header>

      <div className="relative h-[360px] overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-aurora/20 via-teal/10 to-black">
        <AnimatePresence mode="wait">
          {active ? (
            <motion.article
              key={active.id}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -18 }}
              transition={{ duration: 0.24 }}
              className="absolute inset-0"
            >
              {active.mediaUrl ? (
                <Image
                  src={active.mediaUrl}
                  alt={active.displayName}
                  fill
                  sizes="(max-width: 768px) 100vw, 640px"
                  className="absolute inset-0 object-cover"
                />
              ) : null}
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />

              <div className="absolute bottom-0 left-0 right-0 space-y-2 p-4">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <h3 className="text-xl font-semibold">{active.displayName}</h3>
                    <p className="text-sm text-fog/80">{active.headline ?? 'High resonance candidate'}</p>
                  </div>
                  <span className="rounded-full border border-sky-300/40 bg-sky-300/10 px-2 py-1 text-xs text-sky-100">
                    {Math.round(active.compatibilityScore)}%
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {active.interests.slice(0, 5).map((interest) => (
                    <span
                      key={interest}
                      className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide"
                    >
                      {interest}
                    </span>
                  ))}
                </div>
              </div>
            </motion.article>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-fog/60">
              Refreshing your feed…
            </div>
          )}
        </AnimatePresence>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => consumeCard('skip')}
          className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs uppercase tracking-wider text-fog/80 transition hover:bg-white/10"
        >
          Skip
        </button>
        <button
          onClick={() => consumeCard('like')}
          className="rounded-xl border border-emerald-300/40 bg-emerald-300/10 px-3 py-2 text-xs uppercase tracking-wider text-emerald-200 transition hover:bg-emerald-300/20"
        >
          Like
        </button>
        <button
          onClick={() => consumeCard('super')}
          className="rounded-xl border border-sky-300/40 bg-sky-300/10 px-3 py-2 text-xs uppercase tracking-wider text-sky-100 transition hover:bg-sky-300/20"
        >
          Super
        </button>
      </div>

      {isLoading ? <p className="text-[11px] text-fog/50">Loading more compatibility candidates…</p> : null}
      {error ? <p className="text-[11px] text-rose-300">{error}</p> : null}
    </section>
  );
}
