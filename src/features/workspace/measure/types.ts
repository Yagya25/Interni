import type { Basis, Quantity } from "@/scene/compile/intermediate";
import type { Id } from "@/scene/model/types";

/**
 * A measurement: a number derived from the Scene, and how well it is known.
 * ================================================================
 *
 * It is the compiler's own `Quantity` — value, basis, σ, interval,
 * confidence, sources — with what a derived number needs besides: its unit,
 * what it was measured on, whether the Scene values behind it are still the
 * ones reconstructed, and the step it is known to. There is no second
 * provenance system: the basis words are the compiler's, and a measurement's
 * basis is the weakest of the Scene values it was derived from.
 *
 * No number here claims an uncertainty the pipeline did not provide. σ is
 * passed through only from a source value that carries one (none do yet: the
 * scale's error has not been measured), and the interval and confidence stay
 * null as they do in the compiler. What a measurement has instead is honest
 * rounding: `resolution` is the step it is shown to, chosen from its basis.
 * It says how finely a number may be read, not how wrong it may be.
 */

export const MEASURE_VERSION = "measure-0.1";

export type Unit = "m" | "m²";

/** Bases, strongest first: the order `intermediate.ts` documents. */
export const BASES: readonly Basis[] = ["measured", "calibrated", "estimated", "inferred", "default"];

/** The weaker of two bases: a number is only as well known as its least known input. */
export const weaker = (a: Basis, b: Basis): Basis => (BASES.indexOf(a) >= BASES.indexOf(b) ? a : b);

export const weakest = (bases: readonly Basis[]): Basis => bases.reduce(weaker, "measured");

/** One Scene value a measurement was derived from, and how it is known now. */
export interface MeasuredInput {
  /** Scene id of the entity, or "room" and "scale" for the room and its scale. */
  id: Id;
  /** The field, as the evidence keys it: "width", "dimensions.0", "transform.position". */
  field: string;
  basis: Basis;
  sources: readonly string[];
  /** The Scene value is no longer the one reconstructed: it was edited since. */
  edited: boolean;
  /** How the reconstructed value relates to the real thing. */
  bound: Bound;
  /** σ the source value itself carries, when it carries one. */
  sigma: number | null;
}

/**
 * How a number relates to the real thing.
 * - `value`: the number itself.
 * - `at-least`: the real thing is at least this (a width from the visible part of a piece; a side of the room closed at the farthest point seen).
 * - `typical`: the thing's own size was not seen; this is its category's typical size.
 */
export type Bound = "value" | "at-least" | "typical";

export interface Measurement extends Quantity<number> {
  available: true;
  unit: Unit;
  /** The Scene ids it was measured on or between. */
  subjects: readonly Id[];
  bound: Bound;
  /** Some Scene value behind it was edited since the reconstruction: it describes the design, not the room as photographed. */
  edited: boolean;
  /** The step it is known to, in its unit. */
  resolution: number;
  /** `value` at that step: the most that may be said of it. */
  rounded: number;
  inputs: readonly MeasuredInput[];
}

/** What could not be measured, and why. Never a made-up number. */
export interface Unavailable {
  available: false;
  reason: string;
}

export type Measured = Measurement | Unavailable;

export const unavailable = (reason: string): Unavailable => ({ available: false, reason });

// ---------------------------------------------------------------------------
// Rounding

/**
 * The step a value is known to, from its basis.
 *
 * | basis                  | lengths                                   | areas  |
 * |------------------------|-------------------------------------------|--------|
 * | measured, calibrated   | 1 cm                                      | 0.1 m² |
 * | estimated              | 5 cm below 1 m, 10 cm to 10 m, 50 cm above | 0.5 m² |
 * | inferred, default      | 10 cm (50 cm above 10 m)                  | 0.5 m² |
 */
export function resolutionOf(basis: Basis, unit: Unit, magnitude: number): number {
  const exact = basis === "measured" || basis === "calibrated";
  if (unit === "m²") return exact ? 0.1 : 0.5;
  const m = Math.abs(magnitude);
  if (exact) return 0.01;
  if (m >= 10) return 0.5;
  return basis === "estimated" && m < 1 ? 0.05 : 0.1;
}

/** A value at a step, without float noise: 0.85 at 0.1 is 0.9, not 0.8 because 0.85 / 0.1 = 8.4999…. */
export function roundTo(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(Number((value / step).toFixed(9))) * step).toFixed(decimals));
}

/**
 * The step and the rounded value together. A value that rounds across a
 * band edge (0.98 m, estimated, rounds up to 1.00) takes the step of the band
 * it lands in, so it is not shown finer than that band allows.
 */
export function rounding(value: number, basis: Basis, unit: Unit, floor = 0): { resolution: number; rounded: number } {
  let resolution = Math.max(floor, resolutionOf(basis, unit, value));
  let rounded = roundTo(value, resolution);
  const settled = Math.max(floor, resolutionOf(basis, unit, rounded));
  if (settled !== resolution) {
    resolution = settled;
    rounded = roundTo(value, resolution);
  }
  return { resolution, rounded };
}

// ---------------------------------------------------------------------------
// Building a measurement

export interface MeasureOptions {
  /** How the number relates to the real thing. Defaults to `value`. */
  bound?: Bound;
  /** The least step the method itself can resolve (a grid's spacing). */
  resolutionFloor?: number;
  /** The rule that derived it, appended to the sources. */
  rule?: string;
  note?: string;
  /** Pass the first input's own σ through: only for a number read straight off that one Scene value (the scale listed beside it). */
  direct?: boolean;
}

/** A measurement derived from `inputs`: their weakest basis, all their sources, edited if any is. */
export function measurement(value: number, unit: Unit, subjects: readonly Id[], inputs: readonly MeasuredInput[], options: MeasureOptions = {}): Measured {
  if (!Number.isFinite(value)) return unavailable("the geometry gives no finite value");
  if (!inputs.length) return unavailable("nothing in the Scene says how this is known");
  const basis = weakest(inputs.map((i) => i.basis));
  const sources = [...new Set([...inputs.flatMap((i) => i.sources), ...(options.rule ? [`rule:${options.rule}`] : [])])];
  const { resolution, rounded } = rounding(value, basis, unit, options.resolutionFloor);
  const sigma = options.direct && !inputs[0].edited && inputs.slice(1).every((i) => i.id === "scale") ? inputs[0].sigma : null;
  return {
    available: true,
    value,
    basis,
    sigma,
    interval: null,
    confidence: null,
    sources,
    ...(options.note ? { note: options.note } : {}),
    unit,
    subjects,
    bound: options.bound ?? "value",
    edited: inputs.some((i) => i.edited),
    resolution,
    rounded,
    inputs,
  };
}

// ---------------------------------------------------------------------------
// Verdicts

/**
 * The answer to "is it at least N?". A value within its own step of the
 * threshold is too close to call: no probability is claimed either way. A
 * lower bound below the threshold cannot say no — the real thing may be
 * larger — so it is too close to call as well.
 */
export type Verdict = "yes" | "no" | "too-close-to-call";

export function atLeast(m: Measurement, threshold: number): Verdict {
  if (Math.abs(m.value - threshold) < m.resolution) return "too-close-to-call";
  if (m.value > threshold) return "yes";
  return m.bound === "at-least" ? "too-close-to-call" : "no";
}
