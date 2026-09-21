import type { Hex, ObjectCategory } from "@/scene/model/types";

/**
 * The words the rule-based reader knows, in one place.
 *
 * Adding a synonym or a name means adding it here and nowhere else: the
 * parser and the planner read these tables, they do not carry strings of
 * their own.
 */

/**
 * Spelling variants, compound words and synonyms folded into one canonical
 * word each, before any intent is looked for. Order matters: longer and
 * more specific phrasings come before the words they contain.
 */
export const CANONICAL: readonly [RegExp, string][] = [
  // Spelling and compounds
  [/\bcolou?rs?\b/g, "colour"],
  [/\bgr[ae]y\b/g, "grey"],
  [/\b([lu])\s*-?\s*shape[ds]?\b/g, "$1-shaped"],
  [/\bcounter\s*-?\s*clockwise\b|\banti\s*-?\s*clockwise\b/g, "anticlockwise"],
  [/°/g, " degrees "],
  [/\bdeg(?:rees?|s)?\b/g, "degrees"],

  // Tone and light
  [/\ba darker (?:colour|shade|tone|finish)\b|\bmore dark\b|\bdarken(?:ed)?\b|\bdeeper\b|\bdark\b/g, "darker"],
  [/\ba lighter (?:colour|shade|tone|finish)\b|\bless dark\b|\blighten(?:ed)?\b|\bpaler\b|\bpale\b/g, "lighter"],
  [/\bbrighten(?:ed)?(?: up)?\b|\bmore light\b|\bmore bright\b|\bbright\b/g, "brighter"],
  [/\bdim(?:mer|med)?\b|\bless light\b|\bless bright\b|\bmoodier\b|\bmoody\b/g, "dimmer"],
  [/\bwarm(?:s|ed)? up\b|\bmore warm\b|\bwarm\b|\bcos(?:y|ier)\b|\bcoz(?:y|ier)\b|\bgolden\b/g, "warmer"],
  [/\bcool(?:s|ed)? down\b|\bmore cool\b|\bcool\b|\bcolder\b|\bcrisper\b|\bfresher\b/g, "cooler"],

  // Size
  [/\bscale up\b|\bmore big\b|\benlarge\b|\blarger\b|\bwider\b|\bbig\b/g, "bigger"],
  [/\bscale down\b|\bless big\b|\bshrink\b|\bnarrower\b|\bsmall\b/g, "smaller"],

  // Motion
  [/\bspin\b|\bswivel\b|\btwist\b|\bpivot\b|\brotate\b/g, "rotate"],
  [/\bcloser to\b|\bnearer(?: to)?\b|\bcloser\b|\btowards?\b|\bnext to\b|\bbeside\b|\bup against\b|\bagainst\b|\bnear\b/g, "toward"],
  [/\bfurther (?:away )?from\b|\bfarther (?:away )?from\b|\baway from\b/g, "awayfrom"],
  [/\bbring\b|\bput\b|\bpush\b|\bpull\b|\bslide\b|\bshift\b|\bnudge\b|\bdrag\b|\breposition\b|\bplace\b/g, "move"],

  // Replacement
  [/\bswap(?:ped)?\b|\bexchange\b|\bsubstitute\b/g, "replace"],
  [/\bswitch (?:it|this|that) (?:out )?for\b/g, "replace it with"],
];

/** Words that mean the room as a whole rather than anything standing in it. */
export const ROOM_WORDS = /\b(room|space|everything|in here|whole place|the place|interior)\b/;
/** Words that point at whatever is selected. */
export const SELECTION_WORDS = /\b(this|that|it|selected|selection)\b/;

/**
 * What each kind of object answers to, beyond its own label. Generic words
 * ("table", "lamp") appear under several categories on purpose: when more
 * than one piece answers, the reader asks which one rather than guessing.
 */
export const OBJECT_NAMES: Partial<Record<ObjectCategory, readonly string[]>> = {
  sofa: ["sofa", "couch", "settee", "loveseat"],
  armchair: ["armchair", "arm chair", "chair", "club chair", "easy chair", "accent chair"],
  "lounge-chair": ["lounge chair", "chair", "sling chair"],
  "coffee-table": ["coffee table", "table", "cocktail table"],
  "side-table": ["side table", "end table", "table"],
  "floor-lamp": ["floor lamp", "standing lamp", "lamp", "light"],
  "pendant-lamp": ["pendant", "pendant lamp", "pendant light", "ceiling light", "hanging lamp", "lamp", "light"],
  plant: ["plant", "tree", "houseplant", "fiddle leaf", "fig"],
  rug: ["rug", "carpet"],
  ottoman: ["ottoman", "pouf", "pouffe", "footstool", "stool"],
  artwork: ["artwork", "art", "picture", "painting", "print"],
  cushion: ["cushions", "cushion", "pillows", "pillow"],
  vase: ["vase"],
  books: ["books", "book"],
  basket: ["basket"],
};

/** Plural names that mean every piece of a kind, for switching lights. */
export const ALL_LAMPS = /\b(lights|lamps|all the lights|all lights|every light)\b/;

/** Surfaces, by the kind of surface they are. */
export const SURFACE_NAMES = {
  wall: /\b(walls?|paint)\b/,
  floor: /\b(floor|flooring|floorboards)\b/,
  ceiling: /\b(ceiling)\b/,
} as const;

/** Openings, by kind. Resized or recoloured, they are not editable yet. */
export const OPENING_NAMES = {
  window: /\b(windows?)\b/,
  door: /\b(doors?|doorway)\b/,
} as const;

/** Named colours a piece can be recoloured to, in the room's own register. */
export const COLOURS: Record<string, Hex> = {
  white: "#efeae2",
  ivory: "#ece3cf",
  cream: "#e6dbc4",
  beige: "#d8c8ad",
  sand: "#d2bf9e",
  grey: "#9b9892",
  charcoal: "#3d3b38",
  black: "#1f1e1c",
  brown: "#6e4f38",
  tan: "#b48a5e",
  terracotta: "#b0603f",
  rust: "#9c4a2a",
  orange: "#c7743d",
  red: "#9a3a2f",
  pink: "#d7a7a0",
  yellow: "#d9b45a",
  mustard: "#c49a3a",
  green: "#6f7d5a",
  sage: "#98a58a",
  olive: "#6b6a3f",
  moss: "#5f6b45",
  blue: "#51657a",
  navy: "#2d3a4f",
  teal: "#3f6b6a",
};

/**
 * Forms people ask for that no builder draws yet. Recognising them lets a
 * replacement be understood and answered honestly instead of misread.
 */
export const UNBUILT_FORMS = [
  "l-shaped",
  "u-shaped",
  "sectional",
  "corner",
  "chaise",
  "modular",
  "chesterfield",
  "camelback",
  "sleeper",
  "oval",
  "square",
  "glass",
  "nesting",
  "arc",
  "wingback",
  "rocking",
  "swivel",
] as const;

/** Materials asked of a replacement, kept as attributes of the request. */
export const MATERIAL_WORDS = ["velvet", "leather", "linen", "boucle", "wool", "oak", "walnut", "marble", "travertine", "rattan", "metal", "brass", "wooden", "wood"] as const;

/**
 * Edits people ask for that this reader recognises as edits but cannot make.
 * Matching them is what lets the answer be "that edit isn't available yet"
 * rather than "I don't understand".
 */
export const UNAVAILABLE_EDITS = /\b(paint|add|remove|delete|hang|install|build|decorate|redesign|restyle|mount|wallpaper|tile|clear|declutter|furnish|duplicate|copy)\b/;

/** Written-out angles, for "turn it ninety degrees". */
export const ANGLE_WORDS: Record<string, number> = {
  fifteen: 15,
  thirty: 30,
  "forty five": 45,
  "forty-five": 45,
  sixty: 60,
  ninety: 90,
  "a quarter": 90,
  quarter: 90,
  half: 180,
  around: 180,
  "a hundred and eighty": 180,
  "one eighty": 180,
};
