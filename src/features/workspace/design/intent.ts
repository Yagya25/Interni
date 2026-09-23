import { STYLE_ORDER, type DesignStyle, type StyleAxes } from "./styles";

/**
 * What a design request asks for, once read.
 * ================================================================
 *
 * The one shape every design provider produces — the deterministic reader
 * today, a language model tomorrow — and the only thing the proposal
 * generator accepts. A model behind this boundary can ask for a style and
 * an atmosphere; it cannot ask for an operation, name an object id, or
 * touch a Scene. That is the whole point of the boundary: the generator
 * decides what a style *means* for this room, and the validator decides
 * whether the result may be shown.
 *
 * A provider's output is untrusted until `validateDesignIntent` has passed
 * it, exactly as `validateIntent` does for edit commands.
 */

export const DESIGN_INTENT_VERSION = "design-intent-0.1";

/** More than a person can compare at a glance, and more than the styles hold. */
export const MAX_VARIANTS = 3;

export interface DesignIntent {
  version: typeof DESIGN_INTENT_VERSION;
  /** The styles asked for, in the order they were asked for. Empty means "choose". */
  styles: readonly DesignStyle[];
  /** The words the atmosphere was asked in, kept for the card. Null when none. */
  atmosphere: string | null;
  /** Each −1 to 1, or null when the request said nothing about that axis. */
  warmth: number | null;
  brightness: number | null;
  contrast: number | null;
  luxury: number | null;
  minimalism: number | null;
  coziness: number | null;
  /** How many directions to offer, 1 to `MAX_VARIANTS`. */
  variantCount: number;
}

export type ValidatedIntent = { ok: true; intent: DesignIntent } | { ok: false; reason: string };

/**
 * Check a provider's output before a single operation is generated from it.
 * Unknown styles are refused by name, axes must be finite and within −1..1,
 * and the variant count must be a whole number the engine can honour.
 * Nothing is coerced.
 */
export function validateDesignIntent(value: unknown): ValidatedIntent {
  try {
    return { ok: true, intent: intentOf(value) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function intentOf(value: unknown): DesignIntent {
  const v = record(value, "intent");
  if (v.version !== undefined && v.version !== DESIGN_INTENT_VERSION) {
    throw new Error(`version must be ${DESIGN_INTENT_VERSION}`);
  }
  const styles = list(v.styles, "styles").map((s, i) => oneOf(s, STYLE_ORDER, `styles[${i}]`));
  if (new Set(styles).size !== styles.length) throw new Error("styles must not repeat");
  const count = v.variantCount === undefined ? 1 : finite(v.variantCount, "variantCount");
  if (!Number.isInteger(count) || count < 1) throw new Error("variantCount must be a whole number of at least 1");
  if (count > MAX_VARIANTS) throw new Error(`variantCount must be at most ${MAX_VARIANTS}`);
  return {
    version: DESIGN_INTENT_VERSION,
    styles,
    atmosphere: v.atmosphere == null ? null : text(v.atmosphere, "atmosphere"),
    warmth: axis(v.warmth, "warmth"),
    brightness: axis(v.brightness, "brightness"),
    contrast: axis(v.contrast, "contrast"),
    luxury: axis(v.luxury, "luxury"),
    minimalism: axis(v.minimalism, "minimalism"),
    coziness: axis(v.coziness, "coziness"),
    variantCount: count,
  };
}

/** The intent's axes, with the ones it said nothing about at zero. */
export function axesOf(intent: DesignIntent): StyleAxes {
  return {
    warmth: intent.warmth ?? 0,
    brightness: intent.brightness ?? 0,
    contrast: intent.contrast ?? 0,
    luxury: intent.luxury ?? 0,
    minimalism: intent.minimalism ?? 0,
    coziness: intent.coziness ?? 0,
  };
}

function axis(v: unknown, at: string): number | null {
  if (v == null) return null;
  const n = finite(v, at);
  if (n < -1 || n > 1) throw new Error(`${at} must be between -1 and 1`);
  return n;
}

function record(v: unknown, at: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${at} must be an object`);
  return v as Record<string, unknown>;
}
function list(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${at} must be an array`);
  return v;
}
function text(v: unknown, at: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${at} must be a non-empty string`);
  return v;
}
function finite(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${at} must be a finite number`);
  return v;
}
function oneOf<T extends string>(v: unknown, options: readonly T[], at: string): T {
  if (typeof v !== "string" || !options.includes(v as T)) throw new Error(`${at} must be one of ${options.join(", ")}`);
  return v as T;
}
