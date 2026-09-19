"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a media query. The server render assumes `false`; the real
 * value is applied during hydration without a mismatch warning.
 */
export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The user's reduced-motion preference, live. */
export function useReducedMotion() {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
