"use client";

import { useEffect, useState } from "react";

/**
 * A value once it has stopped changing for `delay` ms, and whether it is
 * still settling. For readings too heavy to work out again on every frame
 * of a drag: they follow the room once it comes to rest, and say while
 * they are behind it.
 */
export function useSettled<T>(value: T, delay = 200): { value: T; settling: boolean } {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, settled, delay]);
  return { value: settled, settling: !Object.is(settled, value) };
}
