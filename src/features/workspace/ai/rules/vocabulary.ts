import type { Hex, MaterialClass, ObjectCategory } from "@/scene/model/types";

/**
 * The words the rule-based reader knows, in one place.
 *
 * Adding a synonym or a name means adding it here and nowhere else: the
 * reader and the compiler read these tables, they do not carry strings of
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
  [/\bt\.?\s?v\.?\b/g, "tv"],

  // Removing
  [/\btake away\b|\bget rid of\b|\bdelete\b|\bthrow (?:out|away)\b|\bclear away\b/g, "remove"],

  // Daylight, and light by amount, before the words they contain are read as size or height
  [/\b(?:increase|more|boost|raise|add)(?: the)? (?:daylight|natural light|sunlight|day light)\b|\blet (?:more light in|in more light)\b/g, "moredaylight"],
  [/\b(?:reduce|decrease|less|lower|cut|dim)(?: the)? (?:daylight|natural light|sunlight|day light)\b|\blet (?:less light in|in less light)\b/g, "lessdaylight"],
  [/\b(?:increase|raise|boost|turn up)(?: the)? (?:brightness|lighting|lights?)\b/g, "brighter"],
  [/\b(?:reduce|decrease|lower|turn down)(?: the)? (?:brightness|lighting|lights?)\b/g, "dimmer"],

  // Tone and light
  [/\ba darker (?:colour|shade|tone|finish)\b|\bmore dark\b|\bdarken(?:ed)?\b|\bdeeper\b|\bdark\b/g, "darker"],
  [/\ba lighter (?:colour|shade|tone|finish)\b|\bless dark\b|\blighten(?:ed)?\b|\bpaler\b|\bpale\b/g, "lighter"],
  [/\bbrighten(?:ed)?(?: up)?\b|\bmore light\b|\bmore bright\b|\bbright\b/g, "brighter"],
  [/\bdim(?:mer|med)?\b|\bless light\b|\bless bright\b|\bmoodier\b|\bmoody\b/g, "dimmer"],
  [/\bwarm(?:s|ed)? up\b|\bmore warm\b|\bwarm\b|\bcos(?:y|ier)\b|\bcoz(?:y|ier)\b|\bgolden\b/g, "warmer"],
  [/\bcool(?:s|ed)? down\b|\bmore cool\b|\bcool\b|\bcolder\b|\bcrisper\b|\bfresher\b/g, "cooler"],

  // Size
  [/\bscale up\b|\bmore big\b|\benlarge\b|\blarger\b|\bwider\b|\bbig\b|\bincrease\b|\bupsize\b|\bgrow\b/g, "bigger"],
  [/\bscale down\b|\bless big\b|\bshrink\b|\bnarrower\b|\bsmall\b|\breduce\b|\bdecrease\b|\bdownsize\b/g, "smaller"],
  [/\btwice as (?:big|large)\b|\bdouble (?:the )?size\b|\bdouble\b/g, "2 times bigger"],
  [/\bhalf (?:the|its) size\b|\bhalf as (?:big|large)\b/g, "0.5 times bigger"],

  // Motion
  [/\bspin\b|\bswivel\b|\btwist\b|\bpivot\b|\brotate\b/g, "rotate"],
  [/\bfacing\b|\bfaces\b|\bpoint(?:s|ing)? at\b/g, "face"],
  [/\bin front of\b/g, "infrontof"],
  [/\bin back of\b|\bbehind\b/g, "behind"],
  [/\bfurther (?:away )?from\b|\bfarther (?:away )?from\b|\baway from\b/g, "awayfrom"],
  [/\bcloser to\b|\bnearer(?: to)?\b|\bcloser\b|\btowards?\b|\bnear\b|\bby the\b/g, "toward"],
  [/\bnext to\b|\bbeside\b|\balongside\b|\bby the side of\b/g, "beside"],
  [/\bup against\b|\bagainst\b|\bback to\b/g, "against"],
  [/\babove\b|\bover\b/g, "above"],
  [/\binside(?: of)?\b|\binto\b|\bwithin\b/g, "into"],
  [/\bon top of\b|\bonto\b/g, "onto"],
  [/\bunderneath\b|\bbeneath\b|\bbelow\b|\bunder\b/g, "under"],
  [/\bforwards?\b|\bahead\b/g, "forward"],
  [/\bbackwards?\b/g, "backward"],
  [/\bupwards?\b|\bhigher\b|\braise\b/g, "up"],
  [/\bdownwards?\b|\blower\b/g, "down"],
  [/\bbring\b|\bput\b|\bpush\b|\bpull\b|\bslide\b|\bshift\b|\bnudge\b|\bdrag\b|\breposition\b|\bplace\b/g, "move"],

  // Replacement
  [/\bswap(?:ped)?\b|\bexchange\b|\bsubstitute\b/g, "replace"],
  [/\bswitch (?:it|this|that) (?:out )?for\b/g, "replace it with"],
];

/** Words that mean the room as a whole rather than anything standing in it. */
export const ROOM_WORDS = /\b(room|space|everything|in here|whole place|the place|interior)\b/;
/** Words that point at whatever is selected. */
export const SELECTION_WORDS = /\b(this|that|it|selected|selection)\b/;
/** Words for the light itself, as opposed to the things it falls on. */
export const LIGHTING_WORDS = /\b(lighting|lights|bulbs|lamps|light)\b/;

/**
 * What each kind of object is called. `own` names the category itself;
 * `alias` are words that also mean it. When a word is one category's own
 * name and another's alias ("cabinet"), the own name wins; when it is only
 * an alias of several ("table"), every one of them answers and the compiler
 * asks which, rather than guessing.
 */
export const OBJECT_NAMES: Partial<Record<ObjectCategory, { own: readonly string[]; alias: readonly string[] }>> = {
  sofa: { own: ["sofa"], alias: ["couch", "settee", "loveseat"] },
  armchair: { own: ["armchair", "arm chair"], alias: ["chair", "club chair", "easy chair", "accent chair"] },
  "lounge-chair": { own: ["lounge chair"], alias: ["chair", "sling chair"] },
  chair: { own: ["chair", "dining chair"], alias: ["seat"] },
  "coffee-table": { own: ["coffee table"], alias: ["table", "cocktail table"] },
  "side-table": { own: ["side table", "end table"], alias: ["table"] },
  "dining-table": { own: ["dining table"], alias: ["table"] },
  desk: { own: ["desk"], alias: ["writing table", "work table"] },
  cabinet: { own: ["cabinet", "cupboard"], alias: [] },
  sideboard: { own: ["sideboard", "credenza"], alias: ["cabinet"] },
  "media-console": { own: ["tv console", "tv stand", "tv unit", "media console", "media unit", "tv cabinet"], alias: ["console", "cabinet", "sideboard"] },
  television: { own: ["tv", "television"], alias: ["telly", "screen", "tv set"] },
  bookshelf: { own: ["bookshelf", "bookcase"], alias: ["shelf", "shelves", "shelving", "shelf unit"] },
  curtain: { own: ["curtain"], alias: ["drape", "drapes"] },
  artwork: { own: ["artwork"], alias: ["art", "picture", "painting", "print", "frame", "picture frame", "photo"] },
  "floor-lamp": { own: ["floor lamp", "standing lamp"], alias: ["lamp", "light"] },
  "pendant-lamp": { own: ["pendant", "pendant lamp", "pendant light", "ceiling light", "hanging lamp"], alias: ["lamp", "light"] },
  plant: { own: ["plant", "houseplant"], alias: ["tree", "fiddle leaf", "fig"] },
  rug: { own: ["rug"], alias: ["carpet", "mat"] },
  ottoman: { own: ["ottoman", "pouf", "pouffe"], alias: ["footstool", "stool"] },
  bench: { own: ["bench"], alias: [] },
  bed: { own: ["bed"], alias: [] },
  cushion: { own: ["cushion", "pillow"], alias: [] },
  vase: { own: ["vase"], alias: [] },
  books: { own: ["books", "book"], alias: [] },
  basket: { own: ["basket"], alias: [] },
};

/** Plural names that mean every lamp, for switching and relighting. */
export const ALL_LAMPS = /\b(lights|lamps|all the lights|all lights|every light|bulbs)\b/;

/** Surfaces, by the kind of surface they are. */
export const SURFACE_NAMES = {
  walls: /\b(walls?|paint)\b/,
  floor: /\b(floor|flooring|floorboards)\b/,
  ceiling: /\b(ceiling)\b/,
} as const;

/** Openings, by kind. */
export const OPENING_NAMES = {
  window: /\b(windows?|glass door|balcony door|balcony)\b/,
  door: /\b(doors?|doorway)\b/,
} as const;

/** Where one thing is relative to another, as a relation the Scene records. */
export const RELATION_TOKENS = {
  toward: "closer_to",
  awayfrom: "away_from",
  beside: "beside",
  above: "above",
  infrontof: "in_front_of",
  behind: "behind",
  against: "against",
  into: "into",
  onto: "onto",
  under: "under",
} as const;

/** Directions a piece can be moved in with nothing named, as they end a command: "move the sofa left a bit". */
export const DIRECTION_WORDS = {
  left: "left",
  right: "right",
  forward: "forward",
  backward: "backward",
  back: "backward",
  up: "up",
  down: "down",
} as const;

/** Lengths, for "30 cm", "half a metre". Metres per unit. */
export const LENGTH_UNITS: readonly [RegExp, number][] = [
  [/^(?:mm|millimet(?:er|re)s?)$/, 0.001],
  [/^(?:cm|centimet(?:er|re)s?)$/, 0.01],
  [/^(?:m|met(?:er|re)s?)$/, 1],
  [/^(?:ft|feet|foot)$/, 0.3048],
  [/^(?:inch|inches)$/, 0.0254],
];
export const WRITTEN_LENGTHS: readonly [RegExp, number][] = [
  [/\bhalf a met(?:er|re)\b/, 0.5],
  [/\b(?:a|one) met(?:er|re)\b/, 1],
  [/\b(?:a|one) foot\b/, 0.3048],
];

/** Places people name that are not things in the room: understood, and answered as not available yet. */
export const PLACE_WORDS = /\b(corner|middle|centre|center)\b/;

/**
 * Words asked of a finish that no piece can be made of. Recognising them is
 * what lets "make the TV liquid" be refused with what the TV can be, rather
 * than answered as not understood.
 */
export const NOT_FINISHES = ["liquid", "gas", "gaseous", "water", "lava", "fire", "flames", "smoke", "air", "plasma", "jelly", "slime", "steam", "vapour", "vapor", "invisible", "ice"] as const;

/** The same relations, as Scene relationship predicates, for "the lamp beside the sofa". "toward" ("near") is any. */
export const RELATION_PREDICATES = {
  toward: "near",
  beside: "beside",
  above: "above",
  infrontof: "in-front-of",
  against: "against",
  on: "on",
  under: "under",
} as const;

/** How much: "slightly", "much". */
export const SLIGHT = /\b(slightly|a bit|a little|a touch|a tad|somewhat|little)\b/;
export const STRONG = /\b(much|a lot|way|far|really|very|lots)\b/;

/** Words for a whole material class, for "make the table glass". */
export const MATERIAL_CLASS_WORDS: Readonly<Record<MaterialClass, readonly string[]>> = {
  wood: ["wood", "wooden", "timber", "oak", "walnut", "teak"],
  fabric: ["fabric", "linen", "velvet", "cotton", "wool", "boucle", "upholstered"],
  leather: ["leather"],
  metal: ["metal", "metallic", "steel", "brass", "iron", "chrome"],
  glass: ["glass"],
  stone: ["stone", "marble", "granite", "travertine", "concrete"],
  ceramic: ["ceramic", "tiled", "porcelain"],
  paint: ["painted"],
  paper: ["paper"],
  plant: [],
};

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
export const UNAVAILABLE_EDITS = /\b(add|hang|install|build|decorate|redesign|restyle|mount|wallpaper|tile|declutter|furnish|duplicate|copy|paint)\b/;

/** Written-out angles, for "turn it ninety degrees". */
export const ANGLE_WORDS: Record<string, number> = {
  fifteen: 15,
  twenty: 20,
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

/** "the second armchair". */
export const ORDINAL_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
