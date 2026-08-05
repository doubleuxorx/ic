/**
 * Presentation state for media nodes: fit mode, playback and file facts.
 *
 * None of this is written to `.canvas` files. Fit mode is a per-session view
 * preference, and playback is inherently temporary.
 */

import { useEffect, useState } from 'react';
import { create } from 'zustand';

import { errorMessage } from '@/shared/errors';
import { ipc, type FileFacts } from '@/shared/ipc-types';

export type FitMode = 'fit' | 'fill' | 'original';

/** Only one media node plays at a time, so many nodes cannot fight for audio. */
interface MediaStore {
  fit: Record<string, FitMode>;
  playingNodeId: string | null;
  /** Bumped per path when a file changes on disk, so views re-read it. */
  factsVersion: Record<string, number>;
  setFit: (nodeId: string, mode: FitMode) => void;
  claimPlayback: (nodeId: string) => void;
  releasePlayback: (nodeId: string) => void;
  bumpFacts: (relativePath: string) => void;
}

export const useMediaStore = create<MediaStore>((set, get) => ({
  fit: {},
  playingNodeId: null,
  factsVersion: {},
  setFit: (nodeId, mode) => set({ fit: { ...get().fit, [nodeId]: mode } }),
  claimPlayback: (nodeId) => set({ playingNodeId: nodeId }),
  releasePlayback: (nodeId) => {
    if (get().playingNodeId === nodeId) set({ playingNodeId: null });
  },
  bumpFacts: (relativePath) =>
    set({
      factsVersion: {
        ...get().factsVersion,
        [relativePath]: (get().factsVersion[relativePath] ?? 0) + 1,
      },
    }),
}));

/** Cache of verified file facts, keyed by path and refreshed on external change. */
const factsCache = new Map<string, FileFacts>();

/** Drop the cached facts for a path and wake every view showing it. */
export const invalidateFacts = (relativePath: string): void => {
  factsCache.delete(relativePath);
  useMediaStore.getState().bumpFacts(relativePath);
};

/** Version of a path, for effect dependencies. */
export const useFactsVersion = (relativePath: string): number =>
  useMediaStore((state) => state.factsVersion[relativePath] ?? 0);

export interface FactsState {
  facts: FileFacts | null;
  error: string | null;
  loading: boolean;
}

export const useFileFacts = (relativePath: string): FactsState => {
  const version = useFactsVersion(relativePath);
  const [state, setState] = useState<FactsState>(() => ({
    facts: factsCache.get(relativePath) ?? null,
    error: null,
    loading: !factsCache.has(relativePath),
  }));

  useEffect(() => {
    let cancelled = false;
    const cached = factsCache.get(relativePath);
    if (cached) {
      setState({ facts: cached, error: null, loading: false });
      return () => {
        cancelled = true;
      };
    }
    // Facts already read for this path stay on screen while they are re-read,
    // so an external change refreshes a media view instead of unmounting it.
    setState((previous) => ({
      facts: previous.facts?.relativePath === relativePath ? previous.facts : null,
      error: null,
      loading: true,
    }));
    ipc
      .fileFacts(relativePath)
      .then((facts) => {
        factsCache.set(relativePath, facts);
        if (!cancelled) setState({ facts, error: null, loading: false });
      })
      .catch((error) => {
        if (!cancelled) setState({ facts: null, error: errorMessage(error), loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [relativePath, version]);

  return state;
};

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
};
