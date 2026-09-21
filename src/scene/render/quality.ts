/**
 * How much rendering a device can afford.
 *
 * Sharpness comes from rendering at the display's own pixel density, and
 * cost grows with the number of pixels drawn. So a tier is a pixel budget
 * as much as a ratio cap: a phone at 3× has few CSS pixels and can afford
 * 2×, while a desktop on a large high-density display would draw four times
 * the pixels of a laptop for no visible gain past its budget.
 *
 *   high      desktop and laptop GPUs: native density up to 2×
 *   balanced  modest hardware: density capped lower, smaller shadow map
 *   low       phones and tablets: 2× on a small screen, smaller shadow map
 *
 * The stage also watches its own frame times and steps the ratio down if a
 * device turns out slower than its tier assumed (see `SceneStage`).
 */

export type StageQuality = "high" | "balanced" | "low";

export interface QualityProfile {
  /** Highest device pixel ratio rendered. */
  maxPixelRatio: number;
  /** Never drawn below this, however slow frames get. */
  minPixelRatio: number;
  /** Most device pixels drawn per frame. */
  pixelBudget: number;
  shadowMapSize: number;
}

export const QUALITY: Record<StageQuality, QualityProfile> = {
  high: { maxPixelRatio: 2, minPixelRatio: 1, pixelBudget: 8.3e6, shadowMapSize: 2048 },
  balanced: { maxPixelRatio: 1.5, minPixelRatio: 1, pixelBudget: 3.7e6, shadowMapSize: 1024 },
  low: { maxPixelRatio: 2, minPixelRatio: 1, pixelBudget: 2.4e6, shadowMapSize: 1024 },
};

/** A first estimate from what the browser says about the device. */
export function chooseQuality(): StageQuality {
  if (typeof window === "undefined") return "high";
  const touchFirst = window.matchMedia("(pointer: coarse)").matches;
  const smallScreen = Math.min(window.screen.width, window.screen.height) <= 820;
  if (touchFirst && smallScreen) return "low";
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (cores <= 4 || memory <= 4) return "balanced";
  return "high";
}

/** The pixel ratio to render a canvas of `width` × `height` CSS pixels at. */
export function pixelRatioFor(profile: QualityProfile, width: number, height: number, cap = Infinity) {
  const native = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const budgeted = Math.sqrt(profile.pixelBudget / Math.max(1, width * height));
  return Math.max(Math.min(profile.minPixelRatio, native), Math.min(native, profile.maxPixelRatio, budgeted, cap));
}
