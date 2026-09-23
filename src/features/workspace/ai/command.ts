import { ALLOWED_CLASSES } from "@/scene/compile/materials";
import { findById, roomBounds } from "@/scene/model/queries";
import type { Id, Scene, SceneObject } from "@/scene/model/types";
import { MAX_DISTANCE, type Degree, type LightingChange, type MaterialChange, type MoveDirection } from "./intent";

/**
 * A command, once everything it names has been found.
 * ================================================================
 *
 *   words → SceneIntent → (entity resolution) → StructuredCommand → SceneOperation[]
 *
 * A `SceneIntent` says what was asked in the words' own terms: "the sofa",
 * "the window". A `StructuredCommand` says it in the scene's: `sofa-0`,
 * `window-0`. It is what the compiler turns into operations and nothing
 * else is, so it is checked here against the scene (`validateCommand`)
 * before a single operation is made: every id must exist and be the right
 * kind of thing, every number finite and within range, every finish one the
 * slot can take.
 *
 * Deterministic: the same scene, selection and words always resolve to the
 * same command, and the same command always compiles to the same operations.
 */

export type StructuredCommand =
  | MoveCommand
  | RotateCommand
  | ScaleCommand
  | RemoveCommand
  | MaterialCommand
  | LightingCommand
  | SwitchCommand
  | ReplaceCommand
  | ResetCommand;

export type CommandType = StructuredCommand["type"];

// ---------------------------------------------------------------------------
// What a command acts on

export interface ObjectTarget {
  kind: "object";
  id: Id;
}
/** "The curtains": every piece the words meant. */
export interface ObjectsTarget {
  kind: "objects";
  ids: readonly Id[];
}
/** One finish slot on each piece: a sofa's upholstery, a chair's frame. */
export interface SlotsTarget {
  kind: "slots";
  slots: readonly { objectId: Id; slot: string }[];
}
export interface SurfacesTarget {
  kind: "surfaces";
  surface: "walls" | "floor" | "ceiling";
  ids: readonly Id[];
}
export interface LightsTarget {
  kind: "lights";
  ids: readonly Id[];
}
export interface RoomTarget {
  kind: "room";
}

/** What a move or a turn is measured against. */
export type PlaceRef = { kind: "object"; id: Id } | { kind: "opening"; id: Id } | { kind: "wall"; id: Id };

// ---------------------------------------------------------------------------
// Commands

export type MoveWay = "toward" | "away" | "beside" | "in_front_of" | "behind" | "above" | "against" | MoveDirection;

export interface MoveCommand {
  type: "MOVE_OBJECT";
  target: ObjectTarget;
  parameters: {
    /** Relative to `reference` (toward … against), or a plain direction (left … down). */
    direction: MoveWay;
    /** Required for toward, away, beside, in front of, behind and above; a wall or null (the nearest) for against; null for a plain direction. */
    reference: PlaceRef | null;
    /** Metres, when stated. */
    distance: number | null;
    /** How far, when no distance is stated. */
    amount: Degree;
  };
}

export interface RotateCommand {
  type: "ROTATE_OBJECT";
  target: ObjectTarget | ObjectsTarget;
  /** One of the two: a turn by degrees (clockwise from above), or a turn to face something. */
  parameters: { degrees: number; face: null } | { degrees: null; face: PlaceRef };
}

export interface ScaleCommand {
  type: "SCALE_OBJECT";
  target: ObjectTarget | ObjectsTarget;
  /** Uniform, relative to the current size. */
  parameters: { factor: number };
}

export interface RemoveCommand {
  type: "REMOVE_OBJECT";
  target: ObjectTarget | ObjectsTarget;
}

/** Every change a finish can take; "not a finish" never becomes a command. */
export type FinishChange = Exclude<MaterialChange, { kind: "not_a_finish" }>;

export interface MaterialCommand {
  type: "CHANGE_MATERIAL";
  target: SlotsTarget | SurfacesTarget;
  parameters: { change: FinishChange };
}

export interface LightingCommand {
  type: "CHANGE_LIGHTING";
  target: RoomTarget | LightsTarget;
  /** `includeSurfaces`: "the room warmer" warms the walls too; "the lighting warmer" does not. */
  parameters: { change: LightingChange; includeSurfaces: boolean };
}

export interface SwitchCommand {
  type: "SWITCH_LIGHT";
  target: LightsTarget;
  parameters: { on: boolean };
}

export interface ReplaceCommand {
  type: "REPLACE_OBJECT";
  target: ObjectTarget;
  parameters: { form: string; attributes: readonly string[] };
}

export interface ResetCommand {
  type: "RESET_ROOM";
}

// ---------------------------------------------------------------------------
// Limits

/** What one command may do to a piece's size, and what a piece's size may become. */
export const SCALE_LIMITS = { perCommand: [1 / 3, 3] as const, total: [0.25, 4] as const };
const DIRECTIONS: readonly MoveWay[] = ["toward", "away", "beside", "in_front_of", "behind", "above", "against", "left", "right", "forward", "backward", "up", "down"];
const RELATIVE: readonly MoveWay[] = ["toward", "away", "beside", "in_front_of", "behind", "above"];
const LIGHT_CHANGES: readonly LightingChange[] = ["warmer", "cooler", "brighter", "dimmer", "more_daylight", "less_daylight"];
const DEGREES: readonly Degree[] = ["slight", "normal", "strong"];

// ---------------------------------------------------------------------------
// Validation

export type CommandCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether a command can be compiled against this scene, and if not, why —
 * in words a person can act on when the reason is theirs ("a sofa's
 * upholstery can be fabric or leather, not glass"), and plainly when it is
 * the reader's (an id the scene doesn't have).
 */
export function validateCommand(scene: Scene, command: StructuredCommand): CommandCheck {
  try {
    check(scene, command);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function check(scene: Scene, command: StructuredCommand) {
  switch (command.type) {
    case "MOVE_OBJECT": {
      const object = objectOf(scene, command.target.id);
      const { direction, reference, distance, amount } = command.parameters;
      if (!DIRECTIONS.includes(direction)) throw new Error(`“${direction}” is not a direction a piece can move in`);
      if (!DEGREES.includes(amount)) throw new Error("amount must be slight, normal or strong");
      if (distance !== null) {
        if (!Number.isFinite(distance) || distance <= 0) throw new Error("a distance has to be more than nothing");
        const b = roomBounds(scene);
        const across = Math.min(MAX_DISTANCE, Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]));
        if (distance > across) throw new Error(`${metres(distance)} is further than this room is across (${metres(across)}); a piece can only move within the room`);
      }
      if (RELATIVE.includes(direction) && !reference) throw new Error(`moving ${direction.replace(/_/g, " ")} needs something to move it relative to`);
      if (!RELATIVE.includes(direction) && direction !== "against" && reference) throw new Error(`moving ${direction} takes no reference`);
      if (reference) {
        placeOf(scene, reference);
        if (reference.kind === "object" && reference.id === object.id) throw new Error(`the ${label(object)} can’t be moved relative to itself`);
        if ((direction === "beside" || direction === "in_front_of" || direction === "behind" || direction === "above") && reference.kind !== "object") {
          throw new Error(`a piece goes ${direction.replace(/_/g, " ")} another piece, not a ${reference.kind}`);
        }
        if (direction === "against" && reference.kind !== "wall") throw new Error("a piece goes against a wall");
      }
      if ((direction === "up" || direction === "down") && object.support.kind !== "wall") {
        throw new Error(`the ${label(object)} stands on the ${object.support.kind === "object" ? "piece under it" : "floor"}; only what hangs on a wall moves up or down`);
      }
      return;
    }

    case "ROTATE_OBJECT": {
      const objects = objectsOf(scene, command.target);
      const { degrees, face } = command.parameters;
      if (degrees !== null) {
        if (!Number.isFinite(degrees)) throw new Error("an angle has to be a number");
        if (degrees === 0) throw new Error("a turn of 0° changes nothing");
        if (Math.abs(degrees) > 360) throw new Error(`${Math.round(degrees)}° is more than a full turn. Ask for up to 360°, e.g. “rotate the sofa 20 degrees”`);
      } else {
        placeOf(scene, face);
        if (face.kind === "object" && objects.some((o) => o.id === face.id)) throw new Error("a piece can’t turn to face itself");
      }
      for (const o of objects) {
        if (o.support.kind === "wall") throw new Error(`the ${label(o)} hangs on a wall; turning it would take it off the wall`);
      }
      return;
    }

    case "SCALE_OBJECT": {
      const objects = objectsOf(scene, command.target);
      const { factor } = command.parameters;
      if (!Number.isFinite(factor) || factor <= 0) throw new Error("a size has to stay above zero");
      const [lo, hi] = SCALE_LIMITS.perCommand;
      if (factor > hi || factor < lo) {
        const o = objects[0];
        const width = o.dimensions[0] * o.transform.scale[0] * factor;
        throw new Error(
          `${factor > 1 ? `${round(factor, 0.1)} times bigger` : `${round(1 / factor, 0.1)} times smaller`} would make the ${label(o)} ${metres(width)} wide. One command can resize a piece between a third and three times its size`,
        );
      }
      const [min, max] = SCALE_LIMITS.total;
      for (const o of objects) {
        const next = o.transform.scale.map((s) => s * factor);
        if (next.some((s) => !Number.isFinite(s) || s <= 0)) throw new Error(`the ${label(o)} would have no size`);
        if (next.some((s) => s < min || s > max)) {
          throw new Error(`that would make the ${label(o)} ${factor > 1 ? "more than four times" : "less than a quarter of"} the size it was found at, which this editor doesn’t allow`);
        }
      }
      return;
    }

    case "REMOVE_OBJECT":
      objectsOf(scene, command.target);
      return;

    case "CHANGE_MATERIAL": {
      const { change } = command.parameters;
      if (change.kind === "colour" && !/^#[0-9a-f]{6}$/i.test(change.hex)) throw new Error("a colour must be #rrggbb");
      if (change.kind === "tone" && !["darker", "lighter", "warmer", "cooler"].includes(change.tone)) throw new Error("a tone must be darker, lighter, warmer or cooler");
      if (command.target.kind === "surfaces") {
        const { surface, ids } = command.target;
        const kind = surface === "walls" ? "wall" : surface;
        if (ids.length === 0 || ids.some((id) => findById(scene.surfaces, id)?.kind !== kind)) throw new Error(`the surfaces named aren’t all the room’s ${surface}`);
        allowed(`surface.${kind}`, kind, change);
        return;
      }
      if (command.target.slots.length === 0) throw new Error("no finish was named to change");
      for (const { objectId, slot } of command.target.slots) {
        const object = objectOf(scene, objectId);
        if (!(slot in object.materials)) throw new Error(`the ${label(object)} has no ${slot}`);
        if (change.kind === "class") allowed(`${object.category}.${slot}`, `${label(object)}’s ${slot}`, change);
      }
      return;
    }

    case "CHANGE_LIGHTING": {
      const { change } = command.parameters;
      if (!LIGHT_CHANGES.includes(change)) throw new Error(`“${change}” is not a change light can take`);
      if (command.target.kind === "lights") {
        if (change === "more_daylight" || change === "less_daylight") throw new Error("daylight is the room’s, not a lamp’s");
        lightsOf(scene, command.target.ids);
      } else if ((change === "more_daylight" || change === "less_daylight") && !scene.lights.some((l) => l.kind === "daylight")) {
        throw new Error("this room has no daylight to change");
      }
      return;
    }

    case "SWITCH_LIGHT":
      lightsOf(scene, command.target.ids);
      return;

    case "REPLACE_OBJECT":
      objectOf(scene, command.target.id);
      if (!command.parameters.form.trim()) throw new Error("a replacement needs a form");
      return;

    case "RESET_ROOM":
      return;
  }
}

function objectOf(scene: Scene, id: Id): SceneObject {
  const object = findById(scene.objects, id);
  if (!object) throw new Error(`there is no object ${id} in this room`);
  return object;
}

function objectsOf(scene: Scene, target: ObjectTarget | ObjectsTarget): SceneObject[] {
  const ids = target.kind === "object" ? [target.id] : target.ids;
  if (ids.length === 0) throw new Error("no piece was named");
  return ids.map((id) => objectOf(scene, id));
}

function lightsOf(scene: Scene, ids: readonly Id[]) {
  if (ids.length === 0) throw new Error("no light was named");
  for (const id of ids) {
    const light = findById(scene.lights, id);
    if (!light || light.kind !== "artificial") throw new Error(`there is no lamp light ${id} in this room`);
    if (!findById(scene.objects, light.fixtureId)) throw new Error(`the light ${id} has no fixture in this room`);
  }
}

/** The thing a reference points at, or an error when the scene has no such thing. */
export function placeOf(scene: Scene, ref: PlaceRef) {
  if (ref.kind === "object") return objectOf(scene, ref.id);
  if (ref.kind === "opening") {
    const opening = findById(scene.openings, ref.id);
    if (!opening) throw new Error(`there is no opening ${ref.id} in this room`);
    return opening;
  }
  const wall = findById(scene.surfaces, ref.id);
  if (!wall || wall.kind !== "wall") throw new Error(`there is no wall ${ref.id} in this room`);
  return wall;
}

function allowed(key: string, what: string, change: FinishChange) {
  if (change.kind !== "class") return;
  const classes = ALLOWED_CLASSES[key];
  if (!classes || classes.includes(change.material)) return;
  throw new Error(`A ${what} can be ${classes.join(" or ")}, not ${change.word}`);
}

// ---------------------------------------------------------------------------
// Finish slots

/** The slot that reads as a piece's own colour, by the names slots are given. */
const SLOT_ORDER = ["upholstery", "cover", "fabric", "surface", "top", "body", "pile", "weave", "shade", "screen", "seat", "frame"];

/**
 * The finish a colour or material change goes to. A slot the photograph
 * didn't show on its own (the reconstruction's `unestimated-` stand-ins) is
 * passed over while there is one it did.
 */
export function primarySlot(object: SceneObject): string | undefined {
  const slots = Object.keys(object.materials);
  const seen = slots.filter((slot) => !object.materials[slot].startsWith("unestimated"));
  const pool = seen.length > 0 ? seen : slots;
  return SLOT_ORDER.find((slot) => pool.includes(slot)) ?? pool[0];
}

// ---------------------------------------------------------------------------
// Naming a command back

/** A command in a few words, for the history and the confirmation: "Move sofa toward glazed door". */
export function titleOf(scene: Scene, command: StructuredCommand): string {
  const name = (id: Id) => label(findById(scene.objects, id));
  const names = (t: ObjectTarget | ObjectsTarget) => (t.kind === "object" ? name(t.id) : t.ids.length === 1 ? name(t.ids[0]) : listed(t.ids.map(name)));
  const place = (ref: PlaceRef) => {
    try {
      const p = placeOf(scene, ref);
      return p.label.toLowerCase();
    } catch {
      return ref.id;
    }
  };
  switch (command.type) {
    case "MOVE_OBJECT": {
      const { direction, reference, distance } = command.parameters;
      const by = distance ? ` ${centimetres(distance)}` : "";
      const what = name(command.target.id);
      switch (direction) {
        case "toward":
          return `Move ${what}${by} toward ${place(reference!)}`;
        case "away":
          return `Move ${what}${by} away from ${place(reference!)}`;
        case "beside":
          return `Move ${what} beside ${place(reference!)}`;
        case "in_front_of":
          return `Move ${what} in front of ${place(reference!)}`;
        case "behind":
          return `Move ${what} behind ${place(reference!)}`;
        case "above":
          return `Move ${what} above ${place(reference!)}`;
        case "against":
          return `Move ${what} against ${reference ? place(reference) : "the wall"}`;
        default:
          return `Move ${what} ${direction}${by}`;
      }
    }
    case "ROTATE_OBJECT": {
      const p = command.parameters;
      return p.face ? `Turn ${names(command.target)} to face ${place(p.face)}` : `Rotate ${names(command.target)} ${Math.abs(p.degrees)}° ${p.degrees < 0 ? "anticlockwise" : "clockwise"}`;
    }
    case "SCALE_OBJECT": {
      const f = command.parameters.factor;
      return `Scale ${names(command.target)} ${f > 1 ? "up" : "down"} ${Math.round(Math.abs(f - 1) * 100)}%`;
    }
    case "REMOVE_OBJECT":
      return `Remove ${names(command.target)}`;
    case "CHANGE_MATERIAL": {
      const t = command.target;
      const what = t.kind === "surfaces" ? `the ${t.surface}` : listed([...new Set(t.slots.map((s) => name(s.objectId)))]);
      const c = command.parameters.change;
      return c.kind === "tone" ? `Make ${what} ${c.tone}` : c.kind === "colour" ? `Make ${what} ${c.name}` : `Change ${what} to ${c.word}`;
    }
    case "CHANGE_LIGHTING": {
      const c = command.parameters.change;
      if (c === "more_daylight") return "More daylight";
      if (c === "less_daylight") return "Less daylight";
      const room = c === "brighter" || c === "dimmer" || command.parameters.includeSurfaces;
      const what = command.target.kind === "room" ? (room ? "the room" : "the lighting") : command.target.ids.length > 1 ? "the lamps" : lampName(scene, command.target.ids[0]);
      return `Make ${what} ${c === "dimmer" && command.target.kind === "room" ? "darker" : c}`;
    }
    case "SWITCH_LIGHT":
      return `Switch ${command.target.ids.length > 1 ? "the lamps" : lampName(scene, command.target.ids[0])} ${command.parameters.on ? "on" : "off"}`;
    case "REPLACE_OBJECT":
      return `Replace ${name(command.target.id)} with a ${command.parameters.form} one`;
    case "RESET_ROOM":
      return "Reset the room";
  }
}

function lampName(scene: Scene, lightId: Id) {
  const light = findById(scene.lights, lightId);
  const fixture = light && light.kind === "artificial" ? findById(scene.objects, light.fixtureId) : undefined;
  return label(fixture) || "the lamp";
}

const label = (o: SceneObject | undefined) => (o ? o.label.toLowerCase() : "");
const listed = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const centimetres = (m: number) => (m >= 1 ? `${round(m, 0.01)} m` : `${Math.round(m * 100)} cm`);
const metres = (m: number) => (m >= 1000 ? `${round(m / 1000, 0.1)} km` : m >= 10 ? `${Math.round(m)} m` : `${round(m, 0.01).toFixed(2)} m`);
const round = (value: number, step: number) => {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(value / step) * step).toFixed(decimals));
};
