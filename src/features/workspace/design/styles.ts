import { mixHex, scaleHex } from "@/scene/model/colour";
import type { Hex, MaterialClass } from "@/scene/model/types";


/**
 * The style vocabulary.
 * ================================================================
 *
 * Six descriptive presets, not a ranking: each one says, in structured
 * terms rather than prose, what it does to a room's palette, its finishes
 * and its light. Nothing here knows about any particular room — a preset is
 * read against whatever Scene is open, and the generator decides what of it
 * can honestly be applied.
 *
 * A preset carries three *variants*, so asking for three modern designs
 * gives three genuinely different readings of the same style rather than
 * the same scheme under three names.
 */

export type DesignStyle =
  | "MODERN_WARM"
  | "MINIMAL_NEUTRAL"
  | "SCANDINAVIAN"
  | "DARK_CONTEMPORARY"
  | "CLASSIC_ELEGANT"
  | "COZY";

/** The order styles are offered in when nothing narrows them. */
export const STYLE_ORDER: readonly DesignStyle[] = [
  "MODERN_WARM",
  "SCANDINAVIAN",
  "MINIMAL_NEUTRAL",
  "DARK_CONTEMPORARY",
  "CLASSIC_ELEGANT",
  "COZY",
];

/**
 * The axes a request can ask for, each −1 to 1. A style's own signature is
 * written on the same axes, so a request with no style named ("warmer and
 * more luxurious") picks the style that scores highest against it.
 */
export interface StyleAxes {
  warmth: number;
  brightness: number;
  contrast: number;
  luxury: number;
  minimalism: number;
  coziness: number;
}

export const NO_AXES: StyleAxes = { warmth: 0, brightness: 0, contrast: 0, luxury: 0, minimalism: 0, coziness: 0 };

export interface StylePalette {
  wall: Hex;
  ceiling: Hex;
  /** Timber: frames, shelves, table tops. */
  wood: Hex;
  /** Seating covers. */
  upholstery: Hex;
  /** Curtains and rugs. */
  textile: Hex;
  /** Used sparingly, on the pieces a style lets carry colour. */
  accent: Hex;
  metal: Hex;
  /** Lamp shades. */
  shade: Hex;
}

/** What a style does with a floor it finds. */
export interface FloorRule {
  /** Floors of these classes are left exactly as the room has them. */
  keep: readonly MaterialClass[];
  /**
   * The colour any other floor takes. A colour rather than a shift towards
   * one, so asking for the same design twice is not a second tint — and the
   * floor's pattern, gloss and tile size, which the photograph measured,
   * are kept either way.
   */
  colour: Hex;
}

export interface StyleLight {
  /** The hour the style reads at: 0 = midday, 1 = night. */
  timeOfDay: number;
  /** Lamp colour temperature, in kelvin. */
  kelvin: number;
  /** Lamp output, relative to the output the room was found at. */
  output: number;
  /** Whether the style switches a lamp the photograph found unlit on. */
  lampsOn: boolean;
}

export interface StyleVariant {
  /** Part of a proposal's id, so the same request always names the same proposal. */
  key: string;
  name: string;
  note: string;
  /** Multiplies the palette's lightness. */
  lightness: number;
  /** Mixes the palette towards warm (positive) or cool (negative). */
  warmth: number;
  /** How far the style's accent colour is allowed to go, 0..1. */
  accent: number;
}

export interface StylePreset {
  style: DesignStyle;
  title: string;
  description: string;
  goals: readonly string[];
  palette: StylePalette;
  floor: FloorRule;
  light: StyleLight;
  axes: StyleAxes;
  variants: readonly [StyleVariant, StyleVariant, StyleVariant];
  /** What the style deliberately leaves alone, said plainly. */
  constraints: readonly string[];
}

const WARM_TINT = "#e8b878";
const COOL_TINT = "#9fb6c8";

export const STYLES: Readonly<Record<DesignStyle, StylePreset>> = {
  MODERN_WARM: {
    style: "MODERN_WARM",
    title: "Modern Warm",
    description: "Warm neutral walls, medium-dark wood and warm light, with colour kept to a few pieces.",
    goals: [
      "Warm neutral walls",
      "Medium to dark wood",
      "Warm, low light",
      "Restrained accent colour",
      "Keep a wooden floor as it is",
      "Clean geometry, nothing added",
    ],
    palette: {
      wall: "#e8e0d4",
      ceiling: "#f2ece2",
      wood: "#6b4f36",
      upholstery: "#9a8b78",
      textile: "#cfc3b2",
      accent: "#9c5f3c",
      metal: "#8a7f72",
      shade: "#f3e6cf",
    },
    floor: { keep: ["wood"], colour: "#7a5e42" },
    light: { timeOfDay: 0.32, kelvin: 2700, output: 1.15, lampsOn: true },
    axes: { warmth: 0.6, brightness: 0.2, contrast: 0.2, luxury: 0.3, minimalism: 0.3, coziness: 0.3 },
    variants: [
      { key: "warm", name: "Modern Warm", note: "Warm wood, soft light, neutral walls.", lightness: 1, warmth: 0.06, accent: 0.7 },
      { key: "neutral", name: "Modern Neutral", note: "The same room, read cooler and plainer.", lightness: 1.02, warmth: -0.06, accent: 0.35 },
      { key: "dark-accent", name: "Modern Dark Accent", note: "Deeper timber, one strong accent.", lightness: 0.9, warmth: 0.02, accent: 1 },
    ],
    constraints: ["A wooden floor is kept", "No furniture is moved, added or taken away"],
  },

  MINIMAL_NEUTRAL: {
    style: "MINIMAL_NEUTRAL",
    title: "Minimal Neutral",
    description: "One quiet neutral across the room, very little contrast and almost no colour.",
    goals: [
      "A single neutral palette",
      "Low contrast between surfaces",
      "Almost no accent colour",
      "Keep the floor the room already has",
      "Even, unremarkable light",
    ],
    palette: {
      wall: "#eceae5",
      ceiling: "#f4f3ef",
      wood: "#b7ada0",
      upholstery: "#cfccc5",
      textile: "#dedbd4",
      accent: "#b3aea6",
      metal: "#9b9892",
      shade: "#f2f0ec",
    },
    floor: { keep: ["wood", "stone", "ceramic"], colour: "#cac5bd" },
    light: { timeOfDay: 0.15, kelvin: 3000, output: 1, lampsOn: false },
    axes: { warmth: 0, brightness: 0.4, contrast: -0.3, luxury: 0.1, minimalism: 1, coziness: -0.2 },
    variants: [
      { key: "pale", name: "Minimal Pale", note: "Off-white throughout, nothing raised.", lightness: 1.04, warmth: 0, accent: 0.2 },
      { key: "stone", name: "Minimal Stone", note: "A warmer grey, still quiet.", lightness: 0.97, warmth: 0.03, accent: 0.4 },
      { key: "graphite", name: "Minimal Graphite", note: "The same restraint, a few tones down.", lightness: 0.88, warmth: -0.02, accent: 0.6 },
    ],
    constraints: ["Wood, stone and ceramic floors are kept", "No furniture is moved, added or taken away"],
  },

  SCANDINAVIAN: {
    style: "SCANDINAVIAN",
    title: "Scandinavian",
    description: "A light neutral palette, paler wood, soft fabrics and a bright, even daylight.",
    goals: [
      "Light neutral palette",
      "Lighter wood",
      "Soft fabrics",
      "Bright neutral light",
      "Minimal contrast",
    ],
    palette: {
      wall: "#f0efe9",
      ceiling: "#f8f7f3",
      wood: "#c6a982",
      upholstery: "#d8d4cb",
      textile: "#e4e1d8",
      accent: "#8fa3a6",
      metal: "#a8a49c",
      shade: "#f6f2e8",
    },
    floor: { keep: ["wood"], colour: "#cdb692" },
    light: { timeOfDay: 0.1, kelvin: 3200, output: 1, lampsOn: false },
    axes: { warmth: 0.2, brightness: 0.8, contrast: -0.5, luxury: 0, minimalism: 0.7, coziness: 0.3 },
    variants: [
      { key: "light", name: "Scandinavian Light", note: "Pale oak, white walls, high sun.", lightness: 1.04, warmth: 0, accent: 0.4 },
      { key: "soft", name: "Scandinavian Soft", note: "The same, a shade warmer in the textiles.", lightness: 1, warmth: 0.05, accent: 0.6 },
      { key: "muted", name: "Scandinavian Muted", note: "Greyer, with the colour taken out.", lightness: 0.96, warmth: -0.03, accent: 0.25 },
    ],
    constraints: ["A wooden floor is kept", "No furniture is moved, added or taken away"],
  },

  DARK_CONTEMPORARY: {
    style: "DARK_CONTEMPORARY",
    title: "Dark Contemporary",
    description: "Darker neutrals held under control, a warm accent light, and the room left as open as it was.",
    goals: [
      "Darker neutral materials",
      "Controlled contrast, not black on black",
      "Warmer accent lighting",
      "Ceiling kept light so the room stays open",
      "Keep a wood or stone floor",
    ],
    palette: {
      wall: "#3c3d3f",
      // Deliberately far lighter than the walls: a dark ceiling closes a room in.
      ceiling: "#85868a",
      wood: "#4a3b30",
      upholstery: "#55585c",
      textile: "#6b6e72",
      accent: "#a8724a",
      metal: "#6f6f72",
      shade: "#f0dfc4",
    },
    floor: { keep: ["wood", "stone"], colour: "#55534f" },
    light: { timeOfDay: 0.55, kelvin: 2500, output: 1.25, lampsOn: true },
    axes: { warmth: -0.1, brightness: -0.8, contrast: 0.7, luxury: 0.4, minimalism: 0.4, coziness: 0.1 },
    variants: [
      { key: "charcoal", name: "Dark Charcoal", note: "Charcoal walls, warm lamplight.", lightness: 1, warmth: 0, accent: 0.6 },
      { key: "ink", name: "Dark Ink", note: "Cooler and deeper, contrast held.", lightness: 0.88, warmth: -0.04, accent: 0.45 },
      { key: "warm-shadow", name: "Dark Warm Shadow", note: "Brown-black rather than grey, amber accents.", lightness: 1.04, warmth: 0.08, accent: 0.8 },
    ],
    constraints: ["The ceiling stays lighter than the walls", "Wood and stone floors are kept", "No furniture is moved, added or taken away"],
  },

  CLASSIC_ELEGANT: {
    style: "CLASSIC_ELEGANT",
    title: "Classic Elegant",
    description: "Warm stone walls, dark timber and brass, with a deliberate step up in contrast.",
    goals: [
      "Warm stone walls",
      "Dark timber",
      "Brass rather than steel",
      "A deliberate step up in contrast",
      "Low, warm light in the evening register",
    ],
    palette: {
      wall: "#ded5c6",
      ceiling: "#f0e9dd",
      wood: "#5a4130",
      upholstery: "#a3937d",
      textile: "#c8bba6",
      accent: "#6c5b42",
      metal: "#9f8a5e",
      shade: "#f5e9d2",
    },
    floor: { keep: ["wood"], colour: "#a8977c" },
    light: { timeOfDay: 0.38, kelvin: 2700, output: 1.2, lampsOn: true },
    axes: { warmth: 0.4, brightness: 0.1, contrast: 0.4, luxury: 1, minimalism: -0.3, coziness: 0.2 },
    variants: [
      { key: "ivory", name: "Classic Ivory", note: "Ivory walls against dark timber.", lightness: 1.05, warmth: 0.03, accent: 0.5 },
      { key: "taupe", name: "Classic Taupe", note: "A deeper stone, brass throughout.", lightness: 0.96, warmth: 0.02, accent: 0.7 },
      { key: "deep", name: "Classic Deep", note: "The most contrast this style allows.", lightness: 0.86, warmth: 0.04, accent: 0.9 },
    ],
    constraints: ["A wooden floor is kept", "No furniture is moved, added or taken away"],
  },

  COZY: {
    style: "COZY",
    title: "Cozy",
    description: "Clay and amber, soft textiles, lamps on and the daylight late.",
    goals: [
      "Warm clay walls",
      "Soft, warm textiles",
      "Lamps on, daylight late",
      "Low contrast, nothing stark",
      "Warm timber",
    ],
    palette: {
      wall: "#d9cdbd",
      ceiling: "#e9e0d2",
      wood: "#6f5137",
      upholstery: "#9c7659",
      textile: "#c2a98c",
      accent: "#8d5a3b",
      metal: "#8a7455",
      shade: "#f7e3c0",
    },
    floor: { keep: ["wood"], colour: "#8a6a4b" },
    light: { timeOfDay: 0.62, kelvin: 2400, output: 1.3, lampsOn: true },
    axes: { warmth: 0.9, brightness: -0.2, contrast: -0.1, luxury: 0.1, minimalism: -0.4, coziness: 1 },
    variants: [
      { key: "amber", name: "Cozy Amber", note: "Amber light, warm neutrals.", lightness: 1, warmth: 0.06, accent: 0.7 },
      { key: "clay", name: "Cozy Clay", note: "Clay walls, deeper textiles.", lightness: 0.95, warmth: 0.08, accent: 0.85 },
      { key: "ember", name: "Cozy Ember", note: "The evening reading: lamps doing the work.", lightness: 0.88, warmth: 0.1, accent: 1 },
    ],
    constraints: ["A wooden floor is kept", "No furniture is moved, added or taken away"],
  },
};

// ---------------------------------------------------------------------------
// A style, read for one request

/**
 * A preset, one of its variants and the request's own axes, resolved into
 * the single set of colours and light values the generator works from.
 * Pure: the same three inputs always give the same scheme.
 */
export interface DesignScheme {
  style: DesignStyle;
  variant: StyleVariant;
  title: string;
  description: string;
  goals: readonly string[];
  constraints: readonly string[];
  palette: StylePalette;
  floor: FloorRule;
  light: StyleLight;
  /** How far accents go in this reading, 0 (none) to 1. */
  accent: number;
}

export function resolveScheme(preset: StylePreset, variant: StyleVariant, axes: StyleAxes): DesignScheme {
  // A request's axes nudge the style; they never replace it, so "a warmer
  // Scandinavian room" is still recognisably Scandinavian.
  const lightness = variant.lightness * (1 + 0.12 * axes.brightness - 0.06 * axes.coziness);
  const warmth = variant.warmth + 0.1 * axes.warmth + 0.05 * axes.coziness;
  const contrast = 0.15 * axes.contrast + 0.08 * axes.luxury;
  const accent = clamp01(variant.accent * (1 + 0.4 * axes.luxury - 0.6 * axes.minimalism));

  const tune = (hex: Hex, depth = 0): Hex => shade(hex, lightness * (1 - contrast * depth), warmth);

  return {
    style: preset.style,
    variant,
    title: variant.name,
    description: preset.description,
    goals: preset.goals,
    constraints: preset.constraints,
    palette: {
      // Contrast is spent on the darker half of the palette, so raising it
      // separates timber and seating from the walls rather than muddying both.
      wall: shade(preset.palette.wall, lightness * (1 + contrast * 0.5), warmth),
      ceiling: shade(preset.palette.ceiling, lightness * (1 + contrast * 0.3), warmth),
      wood: tune(preset.palette.wood, 1),
      upholstery: tune(preset.palette.upholstery, 0.6),
      textile: tune(preset.palette.textile, 0.4),
      accent: tune(preset.palette.accent, 0.5),
      metal: tune(preset.palette.metal, 0.3),
      shade: tune(preset.palette.shade),
    },
    floor: { ...preset.floor, colour: tune(preset.floor.colour, 0.8) },
    light: {
      timeOfDay: round(clamp01(preset.light.timeOfDay + 0.08 * axes.warmth + 0.1 * axes.coziness - 0.12 * axes.brightness), 0.01),
      kelvin: Math.round(clamp(preset.light.kelvin - 200 * axes.warmth - 150 * axes.coziness, 1800, 6500) / 50) * 50,
      output: round(clamp(preset.light.output + 0.15 * axes.brightness + 0.1 * axes.coziness, 0.3, 2.5), 0.01),
      lampsOn: preset.light.lampsOn || axes.coziness > 0.3,
    },
    accent,
  };
}

/** A colour lightened or darkened, then leant warm or cool. */
function shade(hex: Hex, lightness: number, warmth: number): Hex {
  const scaled = scaleHex(hex, lightness);
  if (Math.abs(warmth) < 0.005) return scaled;
  return mixHex(scaled, warmth > 0 ? WARM_TINT : COOL_TINT, Math.min(Math.abs(warmth), 0.4));
}

/** The style whose signature best answers these axes; the listed order breaks ties. */
export function styleFor(axes: StyleAxes): DesignStyle {
  let best: DesignStyle = STYLE_ORDER[0];
  let score = -Infinity;
  for (const style of STYLE_ORDER) {
    const s = dot(STYLES[style].axes, axes);
    if (s > score + 1e-9) {
      score = s;
      best = style;
    }
  }
  return best;
}

const dot = (a: StyleAxes, b: StyleAxes) =>
  a.warmth * b.warmth + a.brightness * b.brightness + a.contrast * b.contrast + a.luxury * b.luxury + a.minimalism * b.minimalism + a.coziness * b.coziness;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const round = (value: number, step: number) => {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(value / step) * step).toFixed(decimals));
};
