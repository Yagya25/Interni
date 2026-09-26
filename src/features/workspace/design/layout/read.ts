import type { LayoutAxis, LayoutIntent, LayoutStyle } from "./intent";

/**
 * Reading the layout half of a request, by rule.
 * ================================================================
 *
 * A fixed vocabulary of arrangement words — layout, arrange, conversation,
 * around the TV, more open, less cramped, symmetrical — read into the layout
 * concepts of a `DesignIntent`. Deterministic, and not a language model.
 *
 * The line that matters most is the one with the edit commands: "move the
 * sofa 30 cm left" is one change to one piece and stays a command. A
 * sentence that starts by moving or turning a piece is a command unless it
 * also asks for a layout by name ("move the furniture into a new layout").
 * Arranging the room, or asking for how it should feel to be in it — more
 * social, more open — is a layout request.
 *
 * Input is the design reader's normalised text (lower case, no punctuation).
 */

type Plain = Omit<LayoutIntent, "styles"> & { styles: LayoutStyle[] };

interface Phrase {
  pattern: RegExp;
  /** Which axes it raises (+1) or lowers (−1). */
  axes?: Partial<Record<LayoutAxis, 1 | -1>>;
  style?: LayoutStyle;
}

/** Words that ask for an arrangement by name. */
const LAYOUT_NOUN = /\b(layouts?|arrangements?|floor ?plans?|furniture plans?)\b/;
const LAYOUT_VERB = /\b(re-?arrange|arrange|arranged|reorgani[sz]e|reposition)\b/;
/** A sentence that moves or turns one piece: an edit command, unless it names a layout too. */
const DIRECT = /^(?:please |can you |could you )?(move|put|place|push|pull|slide|shift|drag|rotate|turn|set|swap|replace|remove)\b/;

const PHRASES: readonly Phrase[] = [
  { pattern: /\baround (?:the |my )?(?:tv|television|screen)\b/g, axes: { tvFocus: 1 }, style: "TV_FOCUSED" },
  { pattern: /\b(?:tv|television|screen)[- ]?(?:focused|centred|centered|oriented|facing)\b/g, axes: { tvFocus: 1 }, style: "TV_FOCUSED" },
  { pattern: /\b(?:tv|television|screen|media) (?=layouts?|arrangements?)/g, axes: { tvFocus: 1 }, style: "TV_FOCUSED" },
  { pattern: /\bfor (?:watching )?(?:tv|television|films|movies)\b/g, axes: { tvFocus: 1 }, style: "TV_FOCUSED" },
  { pattern: /\bconversation(?:al)?\b(?: (?:area|group|corner|pit))?/g, axes: { social: 1 }, style: "CONVERSATION" },
  { pattern: /\b(?:social|sociable|together)\b/g, axes: { social: 1 } },
  { pattern: /\bface each other\b|\bfacing each other\b/g, axes: { social: 1 } },
  { pattern: /\b(?:(?:more|less) open|opener|open (?:up|layouts?|floor|plans?|arrangements?|space))\b/g, axes: { openness: 1 }, style: "OPEN" },
  { pattern: /\b(?:spacious|roomier|more (?:floor )?space|more room)\b/g, axes: { openness: 1 } },
  // A complaint asks for less of it: "less cramped", "it feels cluttered".
  { pattern: /\b(?:cramped|cluttered|crowded|boxed in)\b/g, axes: { openness: 1 } },
  { pattern: /\b(?:circulation|flow|walkways?|walking space|room to walk|clear paths?|paths?|get around|walk around)\b/g, axes: { circulation: 1 } },
  { pattern: /\b(?:symmetr(?:y|ic|ical)|balanced|mirrored)\b/g, axes: { symmetry: 1 } },
  { pattern: /\b(?:compact|closer together|close together|tighter|intimate|huddled)\b/g, axes: { compactness: 1 } },
  { pattern: /\b(?:spread out|spaced out|separated?|zoned|zones?|apart)\b/g, axes: { separation: 1 } },
];

/**
 * Style and atmosphere words that describe the layout itself when they stand
 * right before the layout noun — "a cozy conversation layout", "a more
 * minimal furniture arrangement" — and so are not a request for new finishes.
 */
const QUALIFIERS: readonly { pattern: RegExp; axes: Partial<Record<LayoutAxis, 1 | -1>> }[] = [
  { pattern: /^(?:cozy|cosy|cozier|cosier|snug|inviting|homely|intimate)$/, axes: { compactness: 1, social: 1 } },
  { pattern: /^(?:minimal|minimalist|minimalistic|pared|uncluttered|simple|simpler|clean|cleaner|calm|calmer)$/, axes: { openness: 1, symmetry: 1 } },
  { pattern: /^(?:modern|contemporary|scandinavian|scandi|nordic|classic|elegant|luxurious|relaxed|new|different|better|furniture|seating|room|living)$/, axes: {} },
];
const FILLER = /^(?:a|an|the|my|this|more|less|much|very|really|slightly|bit|little|some|three|two|one|four|five|\d+)$/;
/** Layout words already read by `PHRASES`, which a qualifier may stand in front of. */
const LAYOUT_WORD = /^(?:conversation|conversational|social|sociable|tv|television|screen|media|open|opener|symmetrical|symmetric|balanced|compact|intimate|spacious)$/;

const PRESERVE = /\b(?:keep|leave) (?:the |my |all the )?(?:furniture|layout|arrangement|pieces)(?: where (?:it is|they are)| as (?:it is|they are)| in place| alone)?\b|\b(?:dont|do not|without) (?:move|moving|rearrang\w*) (?:the |any )?(?:furniture|pieces|anything)\b/;

const STRONG = /\b(much|very|far|really|way|a lot|totally|completely)\b/;
const SLIGHT = /\b(slightly|a bit|a little|a touch|a tad|somewhat|subtly)\b/;

export interface LayoutRead {
  /** The layout half of the intent, as plain data for the schema to check. */
  layout: Plain;
  /** The words left once the layout's own words are taken out: what is read for finishes. */
  rest: string;
  /**
   * Whether the words say anything about the layout beyond naming one —
   * "social", "around the TV", "cozy". "Apply the second layout" names one
   * and asks nothing of it: it is an act on the layouts on screen.
   */
  concepts: boolean;
}

/** Whether these words ask for a layout at all. */
export function isLayoutRequest(text: string): boolean {
  const read = readLayout(text);
  return read !== null && !read.layout.preserve;
}

/** The layout words in a sentence, or null when it has none. */
export function readLayout(text: string): LayoutRead | null {
  const named = LAYOUT_NOUN.test(text) || LAYOUT_VERB.test(text);
  // "Move the sofa closer together with the chair" is a command about one piece.
  if (DIRECT.test(text) && !named) return null;

  const layout: Plain = { styles: [], social: null, tvFocus: null, openness: null, circulation: null, symmetry: null, compactness: null, separation: null, preserve: false };
  const strength = STRONG.test(text) ? 1 : SLIGHT.test(text) ? 0.35 : 0.65;
  let rest = text;
  let found = false;
  let concepts = false;
  const sums: Partial<Record<LayoutAxis, number>> = {};
  const raise = (axes: Partial<Record<LayoutAxis, 1 | -1>>, sign: 1 | -1) => {
    for (const [name, direction] of Object.entries(axes) as [LayoutAxis, 1 | -1][]) sums[name] = (sums[name] ?? 0) + direction * sign;
  };

  if (PRESERVE.test(text)) {
    layout.preserve = true;
    rest = rest.replace(new RegExp(PRESERVE.source, "g"), " ");
    found = true;
    concepts = true;
  }

  for (const { pattern, axes, style } of PHRASES) {
    for (const match of text.matchAll(pattern)) {
      if (layout.preserve && !named) continue;
      const before = text.slice(Math.max(0, match.index - 14), match.index);
      // "less social", "not so open": against the axis. A complaint ("less cramped") is already the right way round.
      const negated = /\b(less|not|no|without|fewer)\s+(?:so\s+|too\s+|very\s+)?$/.test(before) || /^less\b/.test(match[0]);
      const complaint = /cramped|cluttered|crowded|boxed/.test(match[0]);
      raise(axes ?? {}, negated && !complaint ? -1 : 1);
      if (style && !negated && !layout.styles.includes(style)) layout.styles.push(style);
      rest = rest.replace(match[0], " ");
      found = true;
      concepts = true;
    }
  }

  // The layout noun and the words that describe it.
  for (const match of text.matchAll(new RegExp(`((?:[a-z-]+ ){0,5})${LAYOUT_NOUN.source}`, "g"))) {
    for (const word of match[1].trim().split(/\s+/).filter(Boolean).reverse()) {
      if (FILLER.test(word) || LAYOUT_WORD.test(word)) continue;
      const qualifier = QUALIFIERS.find(({ pattern }) => pattern.test(word));
      if (!qualifier) break;
      raise(qualifier.axes, 1);
      if (Object.keys(qualifier.axes).length > 0) concepts = true;
      rest = rest.replace(new RegExp(`\\b${word}\\b`), " ");
    }
    rest = rest.replace(match[2], " ");
    found = true;
  }
  const verb = text.match(new RegExp(LAYOUT_VERB.source, "g"));
  if (verb) {
    for (const v of verb) rest = rest.replace(v, " ");
    found = true;
  }

  if (!found) return null;
  for (const [name, sum] of Object.entries(sums) as [LayoutAxis, number][]) {
    if (sum !== 0) layout[name] = Math.sign(sum) * strength;
  }
  return { layout, rest: rest.replace(/\s+/g, " ").trim(), concepts };
}
