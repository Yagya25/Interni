import { BUILDABLE_FORM_WORDS } from "../../assets/catalogue";
import type { Degree, EntityRef, MoveDirection, NearPredicate, SceneIntent, Side } from "../intent";
import type { IntentReader } from "../interpreter";
import type { MaterialClass, ObjectCategory } from "@/scene/model/types";
import {
  ALL_LAMPS,
  ANGLE_WORDS,
  CANONICAL,
  COLOURS,
  DIRECTION_WORDS,
  LENGTH_UNITS,
  LIGHTING_WORDS,
  MATERIAL_CLASS_WORDS,
  MATERIAL_WORDS,
  NOT_FINISHES,
  OBJECT_NAMES,
  OPENING_NAMES,
  ORDINAL_WORDS,
  PLACE_WORDS,
  RELATION_PREDICATES,
  RELATION_TOKENS,
  ROOM_WORDS,
  SELECTION_WORDS,
  SLIGHT,
  STRONG,
  SURFACE_NAMES,
  UNAVAILABLE_EDITS,
  UNBUILT_FORMS,
  WRITTEN_LENGTHS,
} from "./vocabulary";

/**
 * Reading a command, by rule.
 * ================================================================
 *
 * A rule-based reader, not a language model. It works in two steps:
 *
 *   1. normalise — case, punctuation, spelling variants and synonyms are
 *      folded into one canonical vocabulary, so "darken this", "make this
 *      more dark" and "give this a darker colour" all read "… darker …";
 *   2. interpret — a short, ordered list of intent rules each looks for its
 *      own canonical words and produces one `SceneIntent`.
 *
 * Names are recorded, not resolved: the reader says which categories the
 * words can name (and which only by alias); `resolve.ts` looks them up in
 * the scene, where it can tell a sofa from a couch that isn't there, or two
 * tables apart. Anything outside these rules returns null, and the
 * workspace says so.
 */

export const ruleReader: IntentReader = {
  kind: "rules",
  name: "Room rules",
  read: async (text, signal) => {
    if (signal.aborted) throw new Error("Cancelled");
    return read(text);
  },
};

/** Fold wording into the canonical vocabulary. */
export function normalise(input: string): string {
  let text = input
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s°%.-]/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [pattern, word] of CANONICAL) text = text.replace(pattern, word);
  return text.replace(/\s+/g, " ").trim();
}

const colourNames = Object.keys(COLOURS);
/** Form words, less those that are also colours ("olive" is a colour; "olive tree" a form). */
const FORM_WORDS = [...new Set([...BUILDABLE_FORM_WORDS, ...UNBUILT_FORMS])].filter((w) => !colourNames.includes(w));
const has = (text: string, word: string) => new RegExp(`\\b${escape(word)}\\b`).test(text);
const LAMP_CATEGORIES: readonly ObjectCategory[] = ["floor-lamp", "pendant-lamp"];
/** Relations a move can be made in, as canonical words. */
const MOVE_RELATIONS = /\b(toward|awayfrom|beside|above|infrontof|behind|against|into|onto|under)\b/g;

export function read(input: string): SceneIntent | null {
  const raw = input.toLowerCase();
  const text = normalise(input);
  if (!text) return null;
  const degree: Degree = SLIGHT.test(text) ? "slight" : STRONG.test(text) ? "strong" : "normal";

  // Reset --------------------------------------------------------------------
  if (/\b(reset|start over|start again)\b|\bundo everything\b|\b(put|move) everything back\b|\bback to (?:the )?original\b|\brestore the room\b/.test(raw)) {
    return { type: "reset_room" };
  }

  // Daylight, by amount ----------------------------------------------------------
  if (/\b(moredaylight|lessdaylight)\b/.test(text)) {
    return { type: "change_lighting", scope: { kind: "room" }, change: /\bmoredaylight\b/.test(text) ? "more_daylight" : "less_daylight", includeSurfaces: false };
  }

  // Switching a light ------------------------------------------------------
  if ((/\b(turn|switch)\b/.test(text) && /\b(on|off)\b/.test(text) && !/\binto\b/.test(text)) || /\blight up\b/.test(text)) {
    const on = /\bon\b|\blight up\b/.test(text);
    const clause = text.replace(/\b(turn|switch|on|off|light up)\b/g, " ");
    return { type: "switch_light", target: ALL_LAMPS.test(text) ? { kind: "lamps" } : entityOf(clause), on };
  }

  // Replacing a piece with another form ------------------------------------
  const forms = FORM_WORDS.filter((word) => has(text, word));
  const connector = text.match(/\b(?:with|for|to|into)\b\s+(.+)$/);
  const replaceVerb = /\breplace\b/.test(text);
  const changeVerb = /\b(change|convert|transform|turn|make|want|swap|upgrade)\b/.test(text);
  if ((replaceVerb && connector) || (forms.length > 0 && (replaceVerb || changeVerb))) {
    const subject = connector ? text.slice(0, connector.index) : text;
    const wanted = connector ? connector[1] : text;
    const attributes = [...colourNames.filter((c) => has(wanted, c)), ...MATERIAL_WORDS.filter((m) => has(wanted, m))];
    const form = asWritten(forms.length > 0 ? forms.join(" ") : describeRequest(wanted, attributes));
    // The kind of piece asked for, when what is wanted names one: "sofa" in "…into a round sofa".
    const asked = connector ? entityOf(wanted) : null;
    const piece = asked?.kind === "object" && (asked.categories.length > 0 || asked.aliasOf.length > 0) ? { words: asked.words, categories: [...asked.categories, ...asked.aliasOf] } : null;
    return { type: "replace_object", target: entityOf(strip(subject, [...forms, "replace", "change", "convert", "transform", "turn", "make"])), form, attributes, ...(piece && { piece }) };
  }

  // Removing -----------------------------------------------------------------
  if (/\bremove\b/.test(text)) {
    return { type: "remove_object", target: entityOf(text.replace(/\bremove\b/g, " ")) };
  }

  // Turning to face something ---------------------------------------------------
  const face = text.match(/\bface\b/);
  if (face) {
    const subject = text.slice(0, face.index).replace(/\b(rotate|turn|make|so that|so|to|round|around)\b/g, " ");
    return { type: "rotate_object", target: entityOf(subject), degrees: null, face: entityOf(text.slice(face.index! + face[0].length)) };
  }

  // Turning ------------------------------------------------------------------
  if (/\brotate\b/.test(text) || (/\bturn\b/.test(text) && !/\binto\b/.test(text))) {
    const angle = angleIn(text);
    // "Turn the chair towards the TV", with no angle, is turning it to face the TV.
    const toward = angle ? null : text.match(/\btoward\b/);
    if (toward) {
      const subject = text.slice(0, toward.index).replace(/\b(rotate|turn)\b/g, " ");
      return { type: "rotate_object", target: entityOf(subject), degrees: null, face: entityOf(text.slice(toward.index! + toward[0].length)) };
    }
    const anticlockwise = /\b(anticlockwise|left)\b/.test(text);
    const clause = (angle ? text.replace(angle.text, " ") : text).replace(/\b(rotate|turn|clockwise|anticlockwise|left|right|by|degrees|around)\b/g, " ");
    const degrees = angle?.degrees ?? 45;
    return { type: "rotate_object", target: entityOf(clause), degrees: anticlockwise ? -degrees : degrees, face: null };
  }

  // Moving ---------------------------------------------------------------------------
  const moveVerb = /\bmove\b/.test(text);
  const leading = [...text.matchAll(MOVE_RELATIONS)].pop();
  // With no verb, "the sofa closer to the window" is a move; "the chair near the window darker" is not.
  const otherEdit = /\b(make|paint|change|darker|lighter|warmer|cooler|brighter|dimmer|bigger|smaller)\b/.test(text);
  if (moveVerb || (leading && (leading[1] === "toward" || leading[1] === "awayfrom") && !otherEdit)) {
    return readMove(text, degree);
  }

  // A named colour --------------------------------------------------------------
  const colour = colourNames.find((c) => has(text, c));
  if (colour && /\b(make|paint|colour|recolour|change|turn|dye|in|to|more)\b/.test(text)) {
    const clause = text.replace(new RegExp(`\\b${colour}\\b`, "g"), " ").replace(/\b(paint|colour|recolour|change|dye|to|in|more)\b/g, " ");
    return { type: "change_material", target: entityOf(clause), change: { kind: "colour", name: colour, hex: COLOURS[colour] } };
  }

  // A whole material ------------------------------------------------------------
  const withoutOpenings = text.replace(OPENING_NAMES.window, " ").replace(OPENING_NAMES.door, " ");
  const material = (Object.entries(MATERIAL_CLASS_WORDS) as [MaterialClass, readonly string[]][])
    .flatMap(([cls, words]) => words.filter((w) => has(withoutOpenings, w)).map((word) => ({ cls, word })))[0];
  if (material && /\b(make|change|turn|into|to|in|use)\b/.test(text)) {
    return { type: "change_material", target: entityOf(text.replace(new RegExp(`\\b${escape(material.word)}\\b`, "g"), " ")), change: { kind: "class", material: material.cls, word: material.word } };
  }

  // Something nothing is made of: "make the TV liquid" --------------------------------
  const notFinish = NOT_FINISHES.find((w) => has(text, w));
  if (notFinish && /\b(make|change|turn|into|to|in)\b/.test(text)) {
    return { type: "change_material", target: entityOf(text.replace(new RegExp(`\\b${notFinish}\\b`, "g"), " ")), change: { kind: "not_a_finish", word: notFinish } };
  }

  // Warmth and light ------------------------------------------------------------------
  const lightingWords = /\b(lighting|lights|bulbs|lamps)\b/.test(text);
  if (/\b(warmer|cooler)\b/.test(text)) {
    const change = /\bwarmer\b/.test(text) ? "warmer" : "cooler";
    const target = lightingWords ? lightScope(text) : entityOf(text.replace(/\b(warmer|cooler)\b/g, " "));
    if (target.kind === "room" || target.kind === "lamps" || isLamp(target)) {
      return { type: "change_lighting", scope: target, change, includeSurfaces: target.kind === "room" && !lightingWords };
    }
    if (target.kind === "unspecified") return { type: "change_lighting", scope: target, change, includeSurfaces: true };
    return { type: "change_material", target, change: { kind: "tone", tone: change, degree } };
  }
  if (/\b(brighter|dimmer)\b/.test(text)) {
    const change = /\bbrighter\b/.test(text) ? "brighter" : "dimmer";
    const target = lightingWords ? lightScope(text) : entityOf(text.replace(/\b(brighter|dimmer)\b/g, " "));
    if (target.kind === "room" || target.kind === "lamps" || target.kind === "unspecified" || isLamp(target)) {
      return { type: "change_lighting", scope: target, change, includeSurfaces: false };
    }
    return { type: "change_material", target, change: { kind: "tone", tone: change === "brighter" ? "lighter" : "darker", degree } };
  }
  if (/\b(darker|lighter)\b/.test(text)) {
    const tone = /\bdarker\b/.test(text) ? "darker" : "lighter";
    const target = entityOf(text.replace(/\b(darker|lighter)\b/g, " "));
    if (target.kind === "room") return { type: "change_lighting", scope: target, change: tone === "darker" ? "dimmer" : "brighter", includeSurfaces: false };
    return { type: "change_material", target, change: { kind: "tone", tone, degree } };
  }

  // Size --------------------------------------------------------------------------------
  if (/\b(bigger|smaller)\b/.test(text)) {
    const bigger = /\bbigger\b/.test(text);
    const times = text.match(/(?:^|\s)(-?\d+(?:\.\d+)?)\s*(?:x|times)\b/);
    const percent = text.match(/(?:^|\s)(-?\d+(?:\.\d+)?)\s*(?:%|percent)/);
    const step = degree === "slight" ? 1.08 : degree === "strong" ? 1.3 : 1.15;
    const factor = times
      ? bigger ? Number(times[1]) : 1 / Number(times[1])
      : percent
        ? bigger ? 1 + Number(percent[1]) / 100 : 1 - Number(percent[1]) / 100
        : bigger ? step : 1 / step;
    const clause = text.replace(/-?\b\d+(?:\.\d+)?\s*(?:x|times|%|percent)?/g, " ").replace(/\b(bigger|smaller|by)\b/g, " ");
    return { type: "scale_object", target: entityOf(clause), factor };
  }

  // Recognised as an edit, but not one this build can make ----------------------
  const verb = text.match(UNAVAILABLE_EDITS);
  if (verb) return { type: "unavailable_edit", verb: verb[1] };

  return null;
}

/**
 * A move: a stated distance comes out first; then a direction the command
 * ends on ("left a bit"), else the last relation ("…closer to the window"),
 * else a place ("to the window", "on the table"). What comes before is the
 * piece. With none of these, the destination is left null and the compiler
 * asks where.
 */
function readMove(text: string, degree: Degree): SceneIntent {
  const { metres: distance, text: body } = distanceIn(text);
  const subject = (clause: string) => entityOf(clause.replace(/\bmove\b/g, " "));
  const move = (target: EntityRef, destination: Extract<SceneIntent, { type: "move_object" }>["destination"], d: Degree = degree): SceneIntent => ({
    type: "move_object",
    target,
    destination,
    degree: d,
    distance,
  });

  const direction = body.match(/\b(?:to (?:the|its) |toward (?:the|its) )?(left|right|forward|backward|back|up|down)\s*(?:a bit|a little|a touch|a tad|slightly|somewhat|much|a lot|a little bit)?\s*$/);
  if (direction) {
    return move(subject(body.slice(0, direction.index)), { kind: "direction", direction: DIRECTION_WORDS[direction[1] as keyof typeof DIRECTION_WORDS] as MoveDirection });
  }

  const last = [...body.matchAll(MOVE_RELATIONS)].pop();
  if (last) {
    const relation = RELATION_TOKENS[last[1] as keyof typeof RELATION_TOKENS];
    return move(subject(body.slice(0, last.index)), { kind: "relative", relation, reference: entityOf(body.slice(last.index! + last[0].length)) });
  }

  // "Put the vase on the table": onto.
  const on = body.match(/\bon\s+(?=(?:the|a|an|this|that|my)\b)/);
  if (on) return move(subject(body.slice(0, on.index)), { kind: "relative", relation: "onto", reference: entityOf(body.slice(on.index! + on[0].length)) });

  // "Move the sofa to the window": as close as it goes; "to the sofa", beside it.
  const to = [...body.matchAll(/\bto\s+(?=\S)/g)].pop();
  if (to) {
    const place = body.slice(to.index! + to[0].length);
    const corner = place.match(PLACE_WORDS);
    if (corner) return { type: "unavailable_edit", verb: corner[1] === "corner" ? "corner" : "middle" };
    const reference = entityOf(place);
    const relation = reference.kind === "object" && (reference.categories.length > 0 || reference.aliasOf.length > 0) ? "beside" : "closer_to";
    return move(subject(body.slice(0, to.index)), { kind: "relative", relation, reference }, relation === "closer_to" && degree === "normal" ? "strong" : degree);
  }

  return move(subject(body), null);
}

/** A stated length, in metres, and the text without it. */
function distanceIn(text: string): { metres: number | null; text: string } {
  const numeric = text.match(/(?:\bby\s+)?\b(\d+(?:\.\d+)?)\s*([a-z]+)\b/g) ?? [];
  for (const phrase of numeric) {
    const [, value, unit] = phrase.match(/(\d+(?:\.\d+)?)\s*([a-z]+)$/)!;
    const per = LENGTH_UNITS.find(([pattern]) => pattern.test(unit));
    if (per) return { metres: round(Number(value) * per[1]), text: text.replace(phrase, " ").replace(/\s+/g, " ").trim() };
  }
  for (const [pattern, metres] of WRITTEN_LENGTHS) {
    const found = text.match(new RegExp(`(?:\\bby\\s+)?${pattern.source}`));
    if (found) return { metres, text: text.replace(found[0], " ").replace(/\s+/g, " ").trim() };
  }
  return { metres: null, text };
}

// ---------------------------------------------------------------------------
// What a clause names

/** Every known name, longest first, with the categories it names and the ones it is an alias of. */
const NAMES = (() => {
  const entries = new Map<string, { own: ObjectCategory[]; alias: ObjectCategory[] }>();
  for (const [category, names] of Object.entries(OBJECT_NAMES) as [ObjectCategory, { own: readonly string[]; alias: readonly string[] }][]) {
    for (const name of names.own) entries.set(name, { own: [...(entries.get(name)?.own ?? []), category], alias: entries.get(name)?.alias ?? [] });
    for (const name of names.alias) entries.set(name, { own: entries.get(name)?.own ?? [], alias: [...(entries.get(name)?.alias ?? []), category] });
  }
  return [...entries.entries()]
    .map(([name, v]) => ({ name, plural: pluralOf(name), own: v.own, alias: v.alias.filter((c) => !v.own.includes(c)) }))
    .sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
})();

/**
 * What a clause names. A relation inside it ("the lamp beside the sofa",
 * "the chair near the window") narrows the piece by a relationship the scene
 * holds; the room, surfaces, openings and "this" are recognised here; a word
 * that names nothing known is kept, so the answer can say it isn't here.
 */
export function entityOf(clause: string, depth = 0): EntityRef {
  const q = depth === 0 ? clause.match(/\b(beside|above|infrontof|against|toward|under|onto|on)\b(?=\s+(?:the|a|this|that|my)\b)/) : null;
  const head = q ? clause.slice(0, q.index) : clause;
  const base = headEntity(head);
  if (q && base.kind === "object") {
    const token = q[1] === "onto" ? "on" : q[1];
    const predicate = RELATION_PREDICATES[token as keyof typeof RELATION_PREDICATES] as NearPredicate;
    return { ...base, near: { predicate, of: entityOf(clause.slice(q.index! + q[0].length), depth + 1) } };
  }
  return base;
}

function headEntity(clause: string): EntityRef {
  if (ALL_LAMPS.test(clause) && !NAMES.some((n) => n.own.length && hasName(clause, n.name))) return { kind: "lamps" };
  const named = NAMES.find((n) => hasName(clause, n.name) || hasName(clause, n.plural));
  if (named) {
    const plural = named.plural !== named.name && hasName(clause, named.plural) && !hasName(clause, named.name);
    const after = clause.match(new RegExp(`\\b(?:${escape(named.name)}|${escape(named.plural)})\\s+(\\d{1,2})\\b`));
    const before = Object.keys(ORDINAL_WORDS).find((w) => has(clause, w));
    return {
      kind: "object",
      words: plural ? named.plural : named.name,
      categories: named.own,
      aliasOf: named.alias,
      pointed: new RegExp(`\\b(?:this|that)\\s+(?:\\w+\\s+)?${escape(named.name)}\\b`).test(clause),
      plural,
      sides: sidesIn(clause.replace(new RegExp(`\\b${escape(named.name)}\\b`), " ")),
      ordinal: after ? Number(after[1]) : before ? ORDINAL_WORDS[before] : null,
      near: null,
    };
  }
  if (SURFACE_NAMES.walls.test(clause)) return { kind: "surface", surface: "walls" };
  if (SURFACE_NAMES.floor.test(clause)) return { kind: "surface", surface: "floor" };
  if (SURFACE_NAMES.ceiling.test(clause)) return { kind: "surface", surface: "ceiling" };
  if (OPENING_NAMES.window.test(clause)) return { kind: "opening", opening: "window" };
  if (OPENING_NAMES.door.test(clause)) return { kind: "opening", opening: "door" };
  if (ROOM_WORDS.test(clause)) return { kind: "room" };
  if (SELECTION_WORDS.test(clause)) return { kind: "selection" };
  const remainder = clause
    .replace(/^(?:please |can you |could you |i want to |id like to |lets )?/, "")
    .replace(/\b(make|move|rotate|turn|resize|replace|change|set|give|switch|paint|the|a|an|my|some|to|by|of|and|slightly|a bit|little|bit|more|less|much|very|really|way|lot|please|somewhat|touch)\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!remainder) return { kind: "unspecified" };
  return { kind: "object", words: remainder, categories: [], aliasOf: [], pointed: false, plural: false, sides: [], ordinal: null, near: null };
}

/** "front-left", "the far right one": one side of each pair, as the camera saw the room. */
function sidesIn(clause: string): Side[] {
  const words = [...clause.matchAll(/\b(left|right|front|back|far|furthest|farthest|nearest)\b/g)].map((m) => m[1]);
  const as = (w: string): Side => (w === "far" || w === "furthest" || w === "farthest" ? "back" : w === "nearest" ? "front" : (w as Side));
  const sides = words.map(as);
  const lateral = sides.find((s) => s === "left" || s === "right");
  const depth = sides.find((s) => s === "front" || s === "back");
  return [lateral, depth].filter((s): s is Side => s !== undefined);
}

/** For light changes: the lamps when the words are about lamps, the room's light otherwise. */
function lightScope(text: string): EntityRef {
  if (/\b(lamps|bulbs)\b/.test(text)) return { kind: "lamps" };
  const named = headEntity(text.replace(LIGHTING_WORDS, " ").replace(/\b(warmer|cooler|brighter|dimmer)\b/g, " "));
  return isLamp(named) ? named : { kind: "room" };
}

const isLamp = (ref: EntityRef) =>
  ref.kind === "object" && (ref.categories.some((c) => LAMP_CATEGORIES.includes(c)) || (ref.categories.length === 0 && ref.aliasOf.length > 0 && ref.aliasOf.every((c) => LAMP_CATEGORIES.includes(c))));

const hasName = (text: string, name: string) => has(text, name);

function pluralOf(name: string) {
  if (/(?:ch|sh|s|x)$/.test(name)) return `${name}es`;
  if (/f$/.test(name)) return `${name.slice(0, -1)}ves`;
  if (/y$/.test(name) && !/[aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/** An angle: a number with "degrees", after "by", or large enough not to be a piece's number; else written out. */
function angleIn(text: string): { degrees: number; text: string } | null {
  const withUnit = text.match(/\b(\d+(?:\.\d+)?)\s*degrees\b/);
  if (withUnit) return { degrees: Number(withUnit[1]), text: withUnit[0] };
  const byNumber = text.match(/\bby\s+(\d+(?:\.\d+)?)\b/);
  if (byNumber) return { degrees: Number(byNumber[1]), text: byNumber[0] };
  const big = [...text.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].filter((m) => Number(m[1]) >= 10).pop();
  if (big) return { degrees: Number(big[1]), text: big[0] };
  const written = Object.keys(ANGLE_WORDS)
    .sort((a, b) => b.length - a.length)
    .find((word) => has(text, word));
  return written ? { degrees: ANGLE_WORDS[written], text: written } : null;
}

/** "a green velvet one" → "green velvet". Used when no known form was named. */
function describeRequest(wanted: string, attributes: readonly string[]) {
  const words = wanted
    .replace(/\b(a|an|the|one|new|different|with|some)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words || attributes.join(" ") || "different";
}

const strip = (text: string, words: readonly string[]) =>
  words.reduce((t, w) => t.replace(new RegExp(`\\b${escape(w)}\\b`, "g"), " "), text);

/** Letter-shaped forms are written with a capital: "l-shaped" → "L-shaped". */
const asWritten = (form: string) =>
  form.replace(/\b([lu])-shaped\b/g, (_, letter: string) => `${letter.toUpperCase()}-shaped`);

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** To a tenth of a millimetre, so "30 cm" is 0.3 m and not 0.30000000000000004. */
const round = (metres: number) => Math.round(metres * 10000) / 10000;
