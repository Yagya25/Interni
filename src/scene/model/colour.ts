import type { Hex } from "./types";

/**
 * Colour arithmetic, in sRGB hex.
 *
 * Small, shared and pure: the AI command layer shifts a finish by a step,
 * the design engine builds a palette from a style, and both have to agree
 * on what "a little warmer" does to a colour, or a proposal and a command
 * would drift apart on the same room.
 *
 * Nothing here is colour science. It is deliberately the same naive mixing
 * the editor has always used; the measured colours come from the compiler.
 */

export const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

export const toHex = (rgb: readonly number[]): Hex =>
  `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;

/** `from`, moved `amount` (0..1) of the way towards `towards`. */
export const mixHex = (from: Hex, towards: string, amount: number): Hex => {
  const a = channels(from);
  const b = channels(towards);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
};

/** Every channel multiplied: lighter above 1, darker below. */
export const scaleHex = (from: Hex, factor: number): Hex => toHex(channels(from).map((v) => v * factor));

/** Perceived lightness, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * How warm a colour reads, −1 (cool) to 1 (warm): red against blue, scaled
 * by how much colour there is at all, so a grey is near zero whichever way
 * it leans.
 */
export function warmth(hex: string): number {
  const [r, , b] = channels(hex);
  return clamp((r - b) / 128, -1, 1);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
