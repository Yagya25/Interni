import type { Basis } from "@/scene/compile/intermediate";
import type { Measured, Measurement } from "./types";

/**
 * Measurements in words, never finer than they are known.
 * ================================================================
 *
 * A number is shown at its own step (`resolution`), with "≈" unless it was
 * measured or calibrated, "at least" when it is a lower bound, and
 * "typical" when it is a category's typical size rather than the thing's
 * own. Its basis is named in the compiler's words, so measured, calibrated,
 * estimated, inferred and default stay distinct, and a number that
 * describes an edited design says so.
 */

/** The digits of a measurement at its step: 2.2, 0.45, 18, 18.5. */
export function digits(m: Measurement): string {
  const decimals = Math.max(0, Math.ceil(-Math.log10(m.resolution) - 1e-9));
  const text = m.rounded.toFixed(decimals);
  // A half-square-metre step shows whole metres whole: 18, not 18.0.
  return m.resolution === 0.5 && text.endsWith(".0") ? text.slice(0, -2) : text;
}

const exact = (basis: Basis) => basis === "measured" || basis === "calibrated";

/**
 * "≈ 2.2 m", "2.19 m", "at least ≈ 6.4 m", "typical ≈ 0.9 m", "≈ 18 m²".
 * Something smaller than its own step is "< 0.05 m", not "0.00 m". Unavailable is "—".
 */
export function formatMeasurement(m: Measured): string {
  if (!m.available) return "—";
  const step = m.resolution.toFixed(Math.max(0, Math.ceil(-Math.log10(m.resolution) - 1e-9)));
  const number = m.rounded === 0 && m.value > 0 ? `< ${step} ${m.unit}` : `${exact(m.basis) ? "" : "≈ "}${digits(m)} ${m.unit}`;
  if (m.bound === "at-least") return `at least ${number}`;
  if (m.bound === "typical") return `typical ${number}`;
  return number;
}

/**
 * How a measurement is known, in the compiler's words, and whether it
 * describes an edit. The demonstration room's numbers were authored, and say so.
 */
export function basisOf(m: Measured): string {
  if (!m.available) return "not available";
  if (m.inputs.every((i) => i.sources.includes("demo:authored"))) return "authored, not measured";
  return m.edited ? `${m.basis}, as edited` : m.basis;
}

/** "≈ 0.45 m · estimated" */
export const describeMeasurement = (m: Measured) => (m.available ? `${formatMeasurement(m)} · ${basisOf(m)}` : `— (${m.reason})`);

/**
 * Lengths side by side, "≈ 2.2 × 0.90 × 0.95 m", each at its own step, the
 * shared "≈" and unit said once. Bounds and typical sizes are for the caller
 * to say in words beside it.
 */
export function formatSeries(ms: readonly Measured[]): string {
  const got = ms.filter((m): m is Measurement => m.available);
  if (!got.length || got.length !== ms.length) return "—";
  const approx = got.some((m) => !exact(m.basis));
  return `${approx ? "≈ " : ""}${got.map(digits).join(" × ")} ${got[0].unit}`;
}
