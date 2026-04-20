'use client';

import { useCallback } from 'react';
import DiscoveryFeed, { DiscoveryCandidate } from '@/components/DiscoveryFeed';

const MOCK_LOAD_DELAY_MS = 200;

const INITIAL_CANDIDATES: DiscoveryCandidate[] = [
  {
    id: 'cand-1',
    displayName: 'Ayla',
    headline: 'Long-form conversations and cinematic playlists',
    interests: ['cinema', 'music', 'night-walks', 'design'],
    compatibilityScore: 86,
    freshness: 0.82
  },
  {
    id: 'cand-2',
    displayName: 'Rae',
    headline: 'Mindful routines and thoughtful daily rituals',
    interests: ['wellness', 'journaling', 'coffee', 'travel'],
    compatibilityScore: 79,
    freshness: 0.9
  },
  {
    id: 'cand-3',
    displayName: 'Niko',
    headline: 'Late-night coding and ambient electronic loops',
    interests: ['tech', 'music', 'gaming', 'books'],
    compatibilityScore: 83,
    freshness: 0.76
  },
  {
    id: 'cand-4',
    displayName: 'Mira',
    headline: 'Deep-dive chats about psychology and culture',
    interests: ['psychology', 'podcasts', 'travel', 'art'],
    compatibilityScore: 88,
    freshness: 0.7
  }
];

export default function DiscoveryPage() {
  const loadMore = useCallback(async (cursor: string | null): Promise<DiscoveryCandidate[]> => {
    const seed = cursor ?? 'seed';
    await new Promise((resolve) => setTimeout(resolve, MOCK_LOAD_DELAY_MS));

    return Array.from({ length: 4 }).map((_, index) => {
      const serial = `${seed}-${index + 1}`;
      return {
        id: `cand-${serial}`,
        displayName: `Candidate ${serial}`,
        headline: 'Compatibility graph update just in',
        interests: ['music', 'travel', 'books', 'wellness', 'tech'].slice(0, 3 + (index % 3)),
        compatibilityScore: 72 + (index * 5),
        freshness: Math.max(0.5, 0.95 - index * 0.1)
      };
    });
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-midnight p-6">
      <DiscoveryFeed initialCandidates={INITIAL_CANDIDATES} loadMore={loadMore} />
    </main>
  );
}
