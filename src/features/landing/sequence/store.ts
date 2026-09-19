"use client";

import { useSyncExternalStore } from "react";

/**
 * Where the reader is in the story. Chapter changes are rare (a dozen per
 * visit) so components may re-render on them; continuous progress is only
 * delivered to imperative subscribers and never causes a React render.
 */
type Listener = () => void;
type ProgressListener = (progress: number) => void;

let chapterIndex = -1;
let seek: ((chapter: number | "end") => void) | null = null;
const listeners = new Set<Listener>();
const progressListeners = new Set<ProgressListener>();

export const sequenceStore = {
  setChapter(index: number) {
    if (index === chapterIndex) return;
    chapterIndex = index;
    listeners.forEach((l) => l());
  },
  setProgress(progress: number) {
    progressListeners.forEach((l) => l(progress));
  },
  onProgress(listener: ProgressListener) {
    progressListeners.add(listener);
    return () => {
      progressListeners.delete(listener);
    };
  },
  /** Registered by the sequence; used by navigation to jump to a chapter. */
  registerSeek(fn: typeof seek) {
    seek = fn;
  },
  seek(chapter: number | "end") {
    seek?.(chapter);
  },
};

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** -1 before the story starts (hero). */
export function useChapterIndex() {
  return useSyncExternalStore(
    subscribe,
    () => chapterIndex,
    () => -1,
  );
}
