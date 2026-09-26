import { MAX_VARIANTS } from "./intent";
import { isLayoutRequest, readLayout } from "./layout/read";
import type { DesignStyle } from "./styles";

/**
 * Reading a design request, by rule.
 * ================================================================
 *
 * Deterministic, not a language model: a fixed vocabulary of style names
 * and atmosphere words, read into the same `DesignIntent` a model behind
 * the provider boundary would have to produce. Its output is untrusted
 * until `validateDesignIntent` has passed it, exactly like the edit
 * reader's.
 *
 * What is *not* a design request matters as much as what is. "Make the
 * room warmer" is one edit to this room's light and walls, and stays an
 * edit command with its own preview and its own undo. A design request
 * names a style, asks for a version or an option, or asks for an
 * atmosphere the edit vocabulary has no word for — luxurious, cozy,
 * minimal. The two are kept apart deliberately: one changes the room, the
 * other offers directions for it.
 *
 * Layouts follow the same line. "Move the sofa 30 cm left" is an edit;
 * "give me three furniture layouts", "make the seating more social" and
 * "arrange the room around the TV" are requests for arrangements of the
 * furniture the room already has (`layout/read.ts`). Style words that
 * describe a layout — "a cozy conversation layout" — describe the layout,
 * and do not also ask for new finishes.
 */

export interface DesignIntentProvider {
  readonly kind: "rules" | "model";
  readonly name: string;
  /** One line on what this provider is. */
  readonly note: string;
  readonly examples: readonly string[];
  /** An intent-shaped value, or null when the words are not a design request. */
  read(text: string, signal: AbortSignal): Promise<unknown>;
}

/** What a design request turns out to be: a brief for the generator, or an act on what is on screen. */
export type DesignRequest =
  | { kind: "brief" }
  | { kind: "session"; action: "preview" | "apply" | "dismiss"; ordinal: number | null };

// ---------------------------------------------------------------------------
// Vocabulary

/** Words that make a sentence a design request rather than an edit. */
const DESIGN_NOUN = "(?:designs?|redesigns?|makeovers?|schemes?|variants?|versions?|options?|directions?|ideas?|concepts?|styles?|palettes?|moodboards?|atmospheres?|vibes?)";
const DESIGN_NOUNS = new RegExp(`\\b${DESIGN_NOUN}\\b`);
const LAYOUT_NOUN = "(?:layouts?|arrangements?)";
/** Anything that can be counted, or pointed at on screen: a design or a layout. */
const DIRECTION_NOUN = `(?:${DESIGN_NOUN}|${LAYOUT_NOUN})`;
const DIRECTION_NOUNS = new RegExp(`\\b${DIRECTION_NOUN}\\b`);
/** Words that ask for new finishes, once a layout's own words are set aside. */
const FINISH_NOUNS = /\b(designs?|redesigns?|makeovers?|schemes?|palettes?|styles?|moodboards?|finish|finishes|colou?rs?|paint)\b/;
const FEEL = /\b(feel|feels|feeling|mood)\b/;

const STYLE_WORDS: readonly { pattern: RegExp; style: DesignStyle }[] = [
  // Compounds first: "dark contemporary" is its own style, not "dark" plus "contemporary".
  { pattern: /\b(dark|darker|moody|dramatic)\b[^.]*\b(contemporary|modern)\b|\b(contemporary|modern)\b[^.]*\b(dark|darker|moody)\b/, style: "DARK_CONTEMPORARY" },
  { pattern: /\b(scandinavian|scandi|nordic|hygge)\b/, style: "SCANDINAVIAN" },
  { pattern: /\b(minimal|minimalist|minimalistic|pared back|uncluttered)\b/, style: "MINIMAL_NEUTRAL" },
  { pattern: /\b(cozy|cosy|snug|inviting|homely)\b/, style: "COZY" },
  { pattern: /\b(classic|elegant|luxurious|luxury|opulent|refined|grand)\b/, style: "CLASSIC_ELEGANT" },
  { pattern: /\b(modern|contemporary)\b/, style: "MODERN_WARM" },
];

/** Each axis, as the words that raise it and the words that lower it. */
const AXES = {
  warmth: {
    up: /\b(warm|warmer|warmth|amber|golden|sunny)\b/,
    down: /\b(cool|cooler|crisp|cold|icy)\b/,
  },
  brightness: {
    up: /\b(bright|brighter|airy|light|lighter|open|fresh)\b/,
    down: /\b(dark|darker|dim|dimmer|moody|shadowy)\b/,
  },
  contrast: {
    up: /\b(contrast|contrasty|dramatic|bold|striking|graphic)\b/,
    down: /\b(soft|softer|subtle|calm|serene|gentle|quiet)\b/,
  },
  luxury: {
    up: /\b(luxurious|luxury|elegant|refined|opulent|upscale|premium|grand)\b/,
    down: /\b(plain|humble|modest|utilitarian)\b/,
  },
  minimalism: {
    up: /\b(minimal|minimalist|minimalistic|pared|uncluttered|sparse|clean|simple)\b/,
    down: /\b(layered|rich|maximal|busy|ornate)\b/,
  },
  coziness: {
    up: /\b(cozy|cosy|cosier|cozier|snug|inviting|homely|hygge)\b/,
    down: /\b(formal|austere|stark|clinical)\b/,
  },
} as const;

type Axis = keyof typeof AXES;
const AXIS_NAMES = Object.keys(AXES) as Axis[];

const STRONG = /\b(much|very|far|really|way|a lot|lot|totally|completely)\b/;
const SLIGHT = /\b(slightly|a bit|a little|a touch|a tad|somewhat|subtly)\b/;

const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, "a couple of": 2, "a couple": 2, "a few": 3, several: 3 };
const ORDINALS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 };

// ---------------------------------------------------------------------------
// Reading

/** Case, punctuation and spacing folded; digits and words kept. */
export function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether these words are a design request at all, and which kind. An act
 * on directions already on screen is read as one whether or not any are —
 * with none, the workspace says so rather than quietly making some — and
 * never when a style is named, so "show me a Scandinavian version" is
 * always a new brief.
 */
export function readDesignRequest(input: string): DesignRequest | null {
  const text = normalise(input);
  if (!text) return null;
  const read = readLayout(text);
  // "Preview the third layout" names a layout and asks nothing of it: an act on what is on screen.
  if (!read?.concepts) {
    const act = readSessionAction(text);
    if (act) return act;
  }
  return isLayoutRequest(text) || isBrief(text) ? { kind: "brief" } : null;
}

/** A style named, a design asked for by name, or an atmosphere the edit vocabulary has no word for. */
function isBrief(text: string): boolean {
  // A style name, or a word that asks for a direction rather than a change.
  // Nothing else: "make the room warmer" is an edit, and stays one.
  return DESIGN_NOUNS.test(text) || FEEL.test(text) || STYLE_WORDS.some(({ pattern }) => pattern.test(text));
}

function readSessionAction(text: string): DesignRequest | null {
  if (STYLE_WORDS.some(({ pattern }) => pattern.test(text))) return null;
  const ordinal = ordinalIn(text);
  const names = DIRECTION_NOUNS.test(text) || /\b(preview|it|this|that|one)\b/.test(text);
  if (/\b(exit|leave|stop|close|discard|dismiss|cancel|clear|never mind|forget)\b/.test(text) && names) {
    return { kind: "session", action: "dismiss", ordinal: null };
  }
  // "Show me three layouts" asks for new ones; "show me the second layout" points at one on screen.
  if (ordinal === null && /\b(designs|redesigns|schemes|variants|versions|options|directions|ideas|concepts|layouts|arrangements)\b/.test(text)) return null;
  if (/\b(apply|use|keep|take|go with|choose|pick)\b/.test(text) && (ordinal !== null || names)) {
    return { kind: "session", action: "apply", ordinal };
  }
  if (/\b(preview|show|see|try|view|look at)\b/.test(text) && (ordinal !== null || DIRECTION_NOUNS.test(text))) {
    return { kind: "session", action: "preview", ordinal };
  }
  // "the second one", with designs on screen and nothing else asked.
  if (ordinal !== null && names) return { kind: "session", action: "preview", ordinal };
  return null;
}

/**
 * The words as a design intent, or null when they are not a brief. The
 * shape is plain data — the provider boundary validates it before the
 * generator sees it, so this function is held to exactly the same schema a
 * model would be.
 */
export function readBrief(input: string): unknown | null {
  const text = normalise(input);
  if (!text) return null;
  const read = readLayout(text);
  const layout = read && !read.layout.preserve ? read.layout : null;
  if (!layout && !isBrief(text)) return null;
  // With a layout asked for, only the words left over can ask for finishes,
  // and they have to name a style, a palette or an atmosphere to do it.
  const rest = read ? read.rest : text;
  const finishes = layout ? asksForFinishes(rest) : true;

  const styles: DesignStyle[] = [];
  const axes: Record<Axis, number | null> = { warmth: null, brightness: null, contrast: null, luxury: null, minimalism: null, coziness: null };
  const words: string[] = [];
  if (finishes) {
    for (const { pattern, style } of STYLE_WORDS) {
      if (pattern.test(rest) && !styles.includes(style)) styles.push(style);
    }
    const strength = STRONG.test(rest) ? 1 : SLIGHT.test(rest) ? 0.35 : 0.65;
    for (const name of AXIS_NAMES) {
      const { sign, found } = axisIn(rest, AXES[name].up, AXES[name].down);
      if (sign === 0) continue;
      axes[name] = round(sign * strength, 0.01);
      words.push(...found);
    }
  }
  // A compound match already claimed its words: "dark contemporary" must not
  // also read as plain "modern".
  const chosen = styles[0] === "DARK_CONTEMPORARY" ? styles.filter((s) => s !== "MODERN_WARM") : styles;

  return {
    version: "design-intent-0.2",
    styles: chosen,
    atmosphere: words.length ? [...new Set(words)].join(", ") : null,
    ...axes,
    variantCount: countIn(text),
    finishes,
    layout: read?.layout.preserve ? { ...read.layout } : layout,
  };
}

/** Whether words left over from a layout request still ask for finishes. */
function asksForFinishes(rest: string): boolean {
  if (FINISH_NOUNS.test(rest) || STYLE_WORDS.some(({ pattern }) => pattern.test(rest))) return true;
  return AXIS_NAMES.some((name) => AXES[name].up.test(rest) || AXES[name].down.test(rest));
}

/** The deterministic provider this build uses. No model, no network, no key. */
export const designRules: DesignIntentProvider = {
  kind: "rules",
  name: "Design rules",
  note: "Reads a style, an atmosphere or a layout into a design brief, then builds the directions from this room's own analysis. It is rule-based, not a language model.",
  examples: [
    "Give me three furniture layouts",
    "Make the seating more social",
    "Arrange the room around the TV",
    "Make the room more open",
    "Give me 3 modern designs",
    "Show me a Scandinavian version",
    "Make this room feel warmer and more luxurious",
    "A minimal neutral version",
    "Make this room darker and more contemporary",
    "Give me a cozy design",
    "Apply the second design",
  ],
  read: async (text, signal) => {
    if (signal.aborted) throw new Error("Cancelled");
    return readBrief(text);
  },
};

// ---------------------------------------------------------------------------

/**
 * Which way an axis was asked for, and in whose words. "Less warm" and
 * "not so bright" count against the axis rather than for it.
 */
function axisIn(text: string, up: RegExp, down: RegExp): { sign: number; found: string[] } {
  let sign = 0;
  const found: string[] = [];
  for (const [pattern, direction] of [
    [up, 1],
    [down, -1],
  ] as const) {
    for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
      const before = text.slice(Math.max(0, match.index - 12), match.index);
      const negated = /\b(less|not|no|without)\s+(?:so\s+|too\s+|very\s+)?$/.test(before);
      sign += negated ? -direction : direction;
      found.push(match[0]);
    }
  }
  return { sign: Math.sign(sign), found };
}

/** How many directions were asked for: a number, a plural, or one. */
function countIn(text: string): number {
  const digits = text.match(/\b(\d+)\b/);
  if (digits) return Number(digits[1]);
  // Longest first, so "a couple of designs" is two rather than "a … design".
  for (const [word, value] of [...Object.entries(NUMBER_WORDS)].sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`\\b${word}\\s+(?:\\w+\\s+){0,2}?${DIRECTION_NOUN}\\b`).test(text)) return value;
  }
  // "designs", "options", "some ideas", "layouts": a plural asks for a spread.
  if (/\b(designs|redesigns|schemes|variants|versions|options|directions|ideas|concepts|layouts|arrangements)\b/.test(text)) return MAX_VARIANTS;
  return 1;
}

function ordinalIn(text: string): number | null {
  for (const [word, value] of Object.entries(ORDINALS)) if (new RegExp(`\\b${word}\\b`).test(text)) return value;
  const numbered = text.match(/\b(?:design|option|version|variant|scheme|idea|direction|layout|arrangement|one)\s+(\d+)\b/) ?? text.match(/\b(\d+)(?:st|nd|rd|th)\b/);
  return numbered ? Number(numbered[1]) : null;
}

const round = (value: number, step: number) => {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(value / step) * step).toFixed(decimals));
};

