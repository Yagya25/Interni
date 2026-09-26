/**
 * What a layout request asks for.
 * ================================================================
 *
 * The layout half of a `DesignIntent`: concepts, not coordinates. A provider
 * — the rule reader today, a model tomorrow — can ask for a conversation
 * layout, a room arranged around its screen, more open floor, symmetry; it
 * cannot name a position, an angle or an operation. What those words mean
 * for *this* room is the planner's to decide, from the room's own geometry.
 *
 * Validated as strictly as the rest of the intent: unknown styles are refused
 * by name, every axis is a finite number in −1..1, nothing is coerced.
 */

/** The layout directions the planner knows how to build. */
export const LAYOUT_STYLES = ["TV_FOCUSED", "CONVERSATION", "OPEN"] as const;
export type LayoutStyle = (typeof LAYOUT_STYLES)[number];

export interface LayoutIntent {
  /** The directions asked for by name, in the order asked. Empty means "choose from the axes". */
  styles: readonly LayoutStyle[];
  // Each axis is −1 to 1, or null when the request said nothing about it.
  /** Seats turned towards one another. */
  social: number | null;
  /** Seats turned towards the screen. */
  tvFocus: number | null;
  /** Floor left clear in the middle of the room. */
  openness: number | null;
  /** Clear paths, above all to the way in. */
  circulation: number | null;
  /** Seats mirrored across the room's main axis, squared to its walls. */
  symmetry: number | null;
  /** Seats drawn in close. */
  compactness: number | null;
  /** More space kept between pieces. */
  separation: number | null;
  /** "Keep the furniture where it is": nothing is moved. */
  preserve: boolean;
}

export const LAYOUT_AXES = ["social", "tvFocus", "openness", "circulation", "symmetry", "compactness", "separation"] as const;
export type LayoutAxis = (typeof LAYOUT_AXES)[number];

/** Check a provider's layout half. Throws with the field named; `validateDesignIntent` reports it. */
export function layoutIntentOf(value: unknown): LayoutIntent | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("layout must be an object");
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.styles ?? [])) throw new Error("layout.styles must be an array");
  const styles = ((v.styles ?? []) as unknown[]).map((s, i) => {
    if (typeof s !== "string" || !LAYOUT_STYLES.includes(s as LayoutStyle)) throw new Error(`layout.styles[${i}] must be one of ${LAYOUT_STYLES.join(", ")}`);
    return s as LayoutStyle;
  });
  if (new Set(styles).size !== styles.length) throw new Error("layout.styles must not repeat");
  if (v.preserve !== undefined && typeof v.preserve !== "boolean") throw new Error("layout.preserve must be true or false");
  const preserve = v.preserve === true;
  const axes = Object.fromEntries(LAYOUT_AXES.map((name) => [name, axis(v[name], `layout.${name}`)])) as Record<LayoutAxis, number | null>;
  if (preserve && (styles.length > 0 || LAYOUT_AXES.some((name) => (axes[name] ?? 0) !== 0))) {
    throw new Error("layout.preserve keeps the furniture where it is, so it cannot also ask for a layout");
  }
  return { styles, ...axes, preserve };
}

function axis(v: unknown, at: string): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${at} must be a finite number`);
  if (v < -1 || v > 1) throw new Error(`${at} must be between -1 and 1`);
  return v;
}

/** The axes, with the ones the request said nothing about at zero. */
export const layoutAxes = (layout: LayoutIntent): Record<LayoutAxis, number> =>
  Object.fromEntries(LAYOUT_AXES.map((name) => [name, layout[name] ?? 0])) as Record<LayoutAxis, number>;
