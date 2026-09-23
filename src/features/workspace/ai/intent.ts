import type { Hex, MaterialClass, ObjectCategory, RelationPredicate } from "@/scene/model/types";

/**
 * What a command asks for, once read.
 * ================================================================
 *
 * The one shape every reader produces — the rule-based reader today, a
 * language model tomorrow — and the only thing the scene-operation compiler
 * accepts. Every field is a closed set or a checked number: once a command
 * has been read, nothing downstream looks at the words again except to name
 * things back to the person.
 *
 * A reader's output is untrusted until `validateIntent` has passed it. That
 * is the provider boundary: a model returns JSON, the validator turns it into
 * a `SceneIntent` or refuses it with a reason, and the compiler turns a
 * `SceneIntent` into scene operations. No reader ever touches a Scene.
 */

export type SceneIntent =
  | MoveIntent
  | RotateIntent
  | ScaleIntent
  | RemoveIntent
  | MaterialIntent
  | LightingIntent
  | SwitchIntent
  | ReplaceIntent
  | ResetIntent
  | UnavailableIntent;

export type IntentType = SceneIntent["type"];

/** How much: "slightly darker", "much bigger", "a bit closer". */
export type Degree = "slight" | "normal" | "strong";

/** Where a piece goes relative to something else in the room. */
export type MoveRelation =
  | "closer_to"
  | "away_from"
  | "beside"
  | "above"
  | "in_front_of"
  | "behind"
  | "against"
  /** "inside the ceiling", "onto the table", "under the rug": understood, so they can be answered. */
  | "into"
  | "onto"
  | "under";

/**
 * A direction with no reference: left and right as the photograph's camera
 * saw the room; forward and backward the way the piece faces (towards the
 * camera for a piece with no front); up and down for what hangs on a wall.
 */
export type MoveDirection = "left" | "right" | "forward" | "backward" | "up" | "down";

export type MoveDestination =
  | { kind: "relative"; relation: MoveRelation; reference: EntityRef }
  | { kind: "direction"; direction: MoveDirection };

export interface MoveIntent {
  type: "move_object";
  target: EntityRef;
  /** Null when the words gave no destination ("move the sofa"): the compiler asks where. */
  destination: MoveDestination | null;
  degree: Degree;
  /** A distance the words stated ("30 cm", "half a metre"), in metres. */
  distance: number | null;
}

export interface RotateIntent {
  type: "rotate_object";
  target: EntityRef;
  /** Seen from above: positive is clockwise. Null when the piece is turned to face something. */
  degrees: number | null;
  /** "Face the TV": what the piece's front should point at. */
  face: EntityRef | null;
}

export interface ScaleIntent {
  type: "scale_object";
  target: EntityRef;
  /** Uniform, relative to its current size: 1.15 is 15% larger. */
  factor: number;
}

export interface RemoveIntent {
  type: "remove_object";
  target: EntityRef;
}

export type MaterialChange =
  | { kind: "tone"; tone: "darker" | "lighter" | "warmer" | "cooler"; degree: Degree }
  | { kind: "colour"; name: string; hex: Hex }
  | { kind: "class"; material: MaterialClass; word: string }
  /** "Make the TV liquid": asked as a finish, but nothing is made of it. Always refused, saying what the piece can be. */
  | { kind: "not_a_finish"; word: string };

export interface MaterialIntent {
  type: "change_material";
  target: EntityRef;
  change: MaterialChange;
}

/** Daylight changes the hour only; the others reach the lamps too. */
export type LightingChange = "warmer" | "cooler" | "brighter" | "dimmer" | "more_daylight" | "less_daylight";

export interface LightingIntent {
  type: "change_lighting";
  /** The room's light, every lamp, or one fixture. */
  scope: EntityRef;
  change: LightingChange;
  /** "Make the room warmer" also warms the walls; "make the lighting warmer" does not. */
  includeSurfaces: boolean;
}

export interface SwitchIntent {
  type: "switch_light";
  target: EntityRef;
  on: boolean;
}

export interface ReplaceIntent {
  type: "replace_object";
  target: EntityRef;
  /** The form asked for, as the person put it: "curved", "L-shaped". */
  form: string;
  attributes: readonly string[];
}

export interface ResetIntent {
  type: "reset_room";
}

/** Recognised as an edit this build cannot make ("hang", "add"): answered as such, never guessed at. */
export interface UnavailableIntent {
  type: "unavailable_edit";
  verb: string;
}

// ---------------------------------------------------------------------------
// What a command is about

export type EntityRef =
  /** "this", "it": the selected piece. */
  | { kind: "selection" }
  /** Nothing named at all ("make darker"): the selection, else the room for changes a room can take. */
  | { kind: "unspecified" }
  | ObjectRef
  | { kind: "surface"; surface: "floor" | "walls" | "ceiling" }
  | { kind: "opening"; opening: "window" | "door" }
  | { kind: "lamps" }
  | { kind: "room" };

export interface ObjectRef {
  kind: "object";
  /** The noun phrase as written, normalised: "couch", "floor lamp", "tv". */
  words: string;
  /** Categories the words are the name of ("cabinet" → cabinet). */
  categories: readonly ObjectCategory[];
  /**
   * Categories the words are only an alias of ("cabinet" → TV console),
   * consulted when nothing in the room is of a named category. Both empty
   * when the words name nothing known.
   */
  aliasOf: readonly ObjectCategory[];
  /** "this chair", "that lamp": the selected piece, when it is one of these. */
  pointed: boolean;
  /** "the curtains": every piece that answers, not one of them. */
  plural: boolean;
  /** "the left curtain", "the front-right chair": as seen from the photograph's camera. At most one of each pair. */
  sides: readonly Side[];
  /** "armchair 2", "the second armchair". 1-based. */
  ordinal: number | null;
  /**
   * "the lamp beside the sofa": narrowed by a relationship the Scene holds.
   * "near" is any relationship at all, or failing one, plainly the nearest.
   */
  near: { predicate: NearPredicate; of: EntityRef } | null;
}

export type Side = "left" | "right" | "front" | "back";
export type NearPredicate = RelationPredicate | "near";

// ---------------------------------------------------------------------------
// Validation: the provider boundary

const TYPES: readonly IntentType[] = [
  "move_object",
  "rotate_object",
  "scale_object",
  "remove_object",
  "change_material",
  "change_lighting",
  "switch_light",
  "replace_object",
  "reset_room",
  "unavailable_edit",
];
const RELATIONS: readonly MoveRelation[] = ["closer_to", "away_from", "beside", "above", "in_front_of", "behind", "against", "into", "onto", "under"];
const DIRECTIONS: readonly MoveDirection[] = ["left", "right", "forward", "backward", "up", "down"];
const DEGREES: readonly Degree[] = ["slight", "normal", "strong"];
const TONES = ["darker", "lighter", "warmer", "cooler"] as const;
const LIGHT_CHANGES: readonly LightingChange[] = ["warmer", "cooler", "brighter", "dimmer", "more_daylight", "less_daylight"];
const MATERIAL_CLASSES: readonly MaterialClass[] = ["wood", "fabric", "stone", "glass", "metal", "paint", "ceramic", "paper", "leather", "plant"];
const PREDICATES: readonly NearPredicate[] = ["faces", "beside", "in-front-of", "on", "under", "above", "against", "lit-by", "opposite", "near"];
const SIDES: readonly Side[] = ["left", "right", "front", "back"];
/** The furthest one command may move a piece: further than any room is wide. */
export const MAX_DISTANCE = 20;
const SURFACES = ["floor", "walls", "ceiling"] as const;
const OPENINGS = ["window", "door"] as const;

export type Validated = { ok: true; intent: SceneIntent } | { ok: false; reason: string };

/**
 * Check a reader's output before anything is compiled from it. Unknown
 * types, relations, classes or categories are refused by name; numbers must
 * be finite; nothing is coerced. The compiler then only ever sees a
 * well-formed intent, whoever produced it.
 */
export function validateIntent(value: unknown, categories: readonly string[]): Validated {
  try {
    return { ok: true, intent: intent(value, categories) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function intent(value: unknown, categories: readonly string[]): SceneIntent {
  const v = record(value, "intent");
  const type = oneOf(v.type, TYPES, "type");
  switch (type) {
    case "move_object": {
      const distance = v.distance == null ? null : finite(v.distance, "distance");
      if (distance !== null && (distance <= 0 || distance > MAX_DISTANCE)) throw new Error(`distance must be more than 0 and at most ${MAX_DISTANCE} m`);
      return {
        type,
        target: entity(v.target, "target", categories),
        destination: v.destination == null ? null : destination(v.destination, categories),
        degree: oneOf(v.degree, DEGREES, "degree"),
        distance,
      };
    }
    case "rotate_object": {
      const degrees = v.degrees == null ? null : finite(v.degrees, "degrees");
      const face = v.face == null ? null : entity(v.face, "face", categories);
      if ((degrees === null) === (face === null)) throw new Error("a turn is by degrees or to face something: one of the two");
      return { type, target: entity(v.target, "target", categories), degrees, face };
    }
    case "scale_object": {
      const factor = finite(v.factor, "factor");
      if (factor <= 0) throw new Error("a size has to stay above zero");
      return { type, target: entity(v.target, "target", categories), factor };
    }
    case "remove_object":
      return { type, target: entity(v.target, "target", categories) };
    case "change_material":
      return { type, target: entity(v.target, "target", categories), change: materialChange(v.change) };
    case "change_lighting":
      return {
        type,
        scope: entity(v.scope, "scope", categories),
        change: oneOf(v.change, LIGHT_CHANGES, "change"),
        includeSurfaces: bool(v.includeSurfaces, "includeSurfaces"),
      };
    case "switch_light":
      return { type, target: entity(v.target, "target", categories), on: bool(v.on, "on") };
    case "replace_object": {
      const attributes = list(v.attributes, "attributes").map((a, i) => text(a, `attributes[${i}]`));
      return { type, target: entity(v.target, "target", categories), form: text(v.form, "form"), attributes };
    }
    case "reset_room":
      return { type };
    case "unavailable_edit":
      return { type, verb: text(v.verb, "verb") };
  }
}

function destination(value: unknown, categories: readonly string[]): MoveDestination {
  const v = record(value, "destination");
  const kind = oneOf(v.kind, ["relative", "direction"] as const, "destination.kind");
  if (kind === "direction") return { kind, direction: oneOf(v.direction, DIRECTIONS, "destination.direction") };
  return { kind, relation: oneOf(v.relation, RELATIONS, "destination.relation"), reference: entity(v.reference, "destination.reference", categories) };
}

function materialChange(value: unknown): MaterialChange {
  const v = record(value, "change");
  const kind = oneOf(v.kind, ["tone", "colour", "class", "not_a_finish"] as const, "change.kind");
  if (kind === "not_a_finish") return { kind, word: text(v.word, "change.word") };
  if (kind === "tone") return { kind, tone: oneOf(v.tone, TONES, "change.tone"), degree: oneOf(v.degree, DEGREES, "change.degree") };
  if (kind === "colour") {
    const hex = text(v.hex, "change.hex");
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("change.hex must be #rrggbb");
    return { kind, name: text(v.name, "change.name"), hex: hex.toLowerCase() as Hex };
  }
  return { kind, material: oneOf(v.material, MATERIAL_CLASSES, "change.material"), word: text(v.word, "change.word") };
}

function entity(value: unknown, at: string, categories: readonly string[]): EntityRef {
  const v = record(value, at);
  switch (v.kind) {
    case "selection":
    case "unspecified":
    case "lamps":
    case "room":
      return { kind: v.kind };
    case "surface":
      return { kind: "surface", surface: oneOf(v.surface, SURFACES, `${at}.surface`) };
    case "opening":
      return { kind: "opening", opening: oneOf(v.opening, OPENINGS, `${at}.opening`) };
    case "object": {
      const cats = list(v.categories, `${at}.categories`).map((c, i) => oneOf(c, categories, `${at}.categories[${i}]`) as ObjectCategory);
      const aliasOf = list(v.aliasOf, `${at}.aliasOf`).map((c, i) => oneOf(c, categories, `${at}.aliasOf[${i}]`) as ObjectCategory);
      const near = v.near == null ? null : record(v.near, `${at}.near`);
      return {
        kind: "object",
        words: text(v.words, `${at}.words`),
        categories: cats,
        aliasOf,
        pointed: bool(v.pointed, `${at}.pointed`),
        plural: bool(v.plural, `${at}.plural`),
        sides: sidesOf(v.sides, `${at}.sides`),
        ordinal: v.ordinal == null ? null : positiveInteger(v.ordinal, `${at}.ordinal`),
        near: near ? { predicate: oneOf(near.predicate, PREDICATES, `${at}.near.predicate`), of: entity(near.of, `${at}.near.of`, categories) } : null,
      };
    }
    default:
      throw new Error(`${at}.kind is not a known kind of reference`);
  }
}

function sidesOf(v: unknown, at: string): Side[] {
  const sides = list(v, at).map((s, i) => oneOf(s, SIDES, `${at}[${i}]`));
  const lateral = sides.filter((s) => s === "left" || s === "right");
  const depth = sides.filter((s) => s === "front" || s === "back");
  if (lateral.length > 1 || depth.length > 1) throw new Error(`${at} can hold one of left and right, and one of front and back`);
  return sides;
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
function positiveInteger(v: unknown, at: string): number {
  const n = finite(v, at);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${at} must be a positive integer`);
  return n;
}
function bool(v: unknown, at: string): boolean {
  if (typeof v !== "boolean") throw new Error(`${at} must be true or false`);
  return v;
}
function oneOf<T extends string>(v: unknown, options: readonly T[], at: string): T {
  if (typeof v !== "string" || !options.includes(v as T)) throw new Error(`${at} must be one of ${options.join(", ")}`);
  return v as T;
}
