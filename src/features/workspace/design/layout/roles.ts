import { walls } from "@/scene/model/queries";
import type { Id, ObjectCategory, Scene, SceneObject } from "@/scene/model/types";
import { relationsOf, wallBehind } from "./geometry";

/**
 * What each thing in the room is *for*, spatially.
 * ================================================================
 *
 * A layer derived from the Scene, not a change to it: the ObjectCategory
 * model is untouched, and a role is read from a piece's category, its size
 * and how it is carried. Deterministic — the same room always gives the same
 * roles, in the same order — and rule-based: no confidence is claimed,
 * because there is no evaluation set to calibrate one against. Each role
 * says why it was given.
 *
 * `mobility` is what a layout may do with the piece. A layout moves only
 * `movable` pieces (and, with them, what they carry); everything else stays
 * exactly where the photograph put it.
 */

export const ROLES_VERSION = "spatial-roles-0.1";

export type SpatialRoleType =
  | "PRIMARY_SEATING"
  | "SECONDARY_SEATING"
  | "TABLE"
  | "DISPLAY"
  | "STORAGE"
  | "LIGHTING"
  | "DECOR"
  | "ARTWORK"
  | "SLEEPING"
  | "OPENING"
  | "STRUCTURAL";

export type Mobility =
  /** A floor piece a layout may move and turn. */
  | "movable"
  /** On the floor, but held where it is by what it is: tall storage at its wall, the piece a screen hangs over. */
  | "anchored"
  | "wall-mounted"
  | "ceiling-mounted"
  /** Stands on another piece; it moves only with that piece. */
  | "carried"
  /** Walls, floor, ceiling and openings: never moved. */
  | "structural";

export interface SpatialRole {
  id: Id;
  entity: "object" | "opening" | "surface";
  role: SpatialRoleType;
  mobility: Mobility;
  reasons: readonly string[];
}

const SEATS: Readonly<Partial<Record<ObjectCategory, number>>> = {
  // How many people a piece seats, roughly, which decides the room's main seat.
  sofa: 3,
  bench: 2,
  "lounge-chair": 1,
  armchair: 1,
  chair: 1,
  ottoman: 0,
};

const ROLE_OF: Readonly<Partial<Record<ObjectCategory, SpatialRoleType>>> = {
  "coffee-table": "TABLE",
  "side-table": "TABLE",
  "dining-table": "TABLE",
  desk: "TABLE",
  television: "DISPLAY",
  bookshelf: "STORAGE",
  "media-console": "STORAGE",
  sideboard: "STORAGE",
  cabinet: "STORAGE",
  "floor-lamp": "LIGHTING",
  "pendant-lamp": "LIGHTING",
  artwork: "ARTWORK",
  bed: "SLEEPING",
};

export const isSeat = (o: SceneObject) => SEATS[o.category] !== undefined;

/** A piece no taller than this lies flat, like a rug, and is walked over. */
export const FLAT = 0.05;

export function spatialRoles(scene: Scene): SpatialRole[] {
  const primary = primarySeat(scene);
  // What hangs over what, as the room now stands: a screen over a console holds the console.
  const underDisplay = new Map<Id, Id>();
  for (const r of relationsOf(scene)) {
    const subject = scene.objects.find((o) => o.id === r.subjectId);
    if (r.predicate === "above" && subject && ROLE_OF[subject.category] === "DISPLAY") underDisplay.set(r.objectId, subject.id);
  }

  const objects = scene.objects.map((object): SpatialRole => {
    const role: SpatialRoleType = isSeat(object) ? (object.id === primary?.id ? "PRIMARY_SEATING" : "SECONDARY_SEATING") : (ROLE_OF[object.category] ?? "DECOR");
    const reasons: string[] = [roleReason(object, role)];
    const { mobility, why } = mobilityOf(scene, object, role, underDisplay);
    reasons.push(why);
    return { id: object.id, entity: "object", role, mobility, reasons };
  });

  const openings = scene.openings.map((opening): SpatialRole => ({
    id: opening.id,
    entity: "opening",
    role: "OPENING",
    mobility: "structural",
    reasons: [`${opening.label}, set in the ${walls(scene).find((w) => w.id === opening.wallId)?.label.toLowerCase() ?? "wall"}: part of the room itself`],
  }));

  const surfaces = scene.surfaces.map((surface): SpatialRole => ({
    id: surface.id,
    entity: "surface",
    role: "STRUCTURAL",
    mobility: "structural",
    reasons: [`The ${surface.label.toLowerCase()} is the room itself`],
  }));

  return [...objects, ...openings, ...surfaces];
}

/** The seat the room is arranged from: the one that seats most, then the largest, then the first by id. */
export function primarySeat(scene: Scene): SceneObject | null {
  const seats = scene.objects.filter((o) => isSeat(o) && o.support.kind === "floor");
  const area = (o: SceneObject) => o.dimensions[0] * o.transform.scale[0] * o.dimensions[2] * o.transform.scale[2];
  return [...seats].sort((a, b) => SEATS[b.category]! - SEATS[a.category]! || area(b) - area(a) || a.id.localeCompare(b.id))[0] ?? null;
}

function roleReason(object: SceneObject, role: SpatialRoleType): string {
  const name = object.label;
  switch (role) {
    case "PRIMARY_SEATING":
      return `${name}: the seat that holds the most people, so the room is arranged from it`;
    case "SECONDARY_SEATING":
      return object.category === "ottoman" ? `${name}: a pull-up seat or a footrest` : `${name}: a seat for one`;
    case "TABLE":
      return `${name}: a surface to set things on`;
    case "DISPLAY":
      return `${name}: a screen the seating can be turned to`;
    case "STORAGE":
      return `${name}: storage`;
    case "LIGHTING":
      return `${name}: a light source`;
    case "ARTWORK":
      return `${name}: artwork`;
    case "SLEEPING":
      return `${name}: a bed`;
    default:
      return `${name}: decoration`;
  }
}

/**
 * What a layout may do with a piece, and why, as a clause: "it hangs on the
 * right wall". The role's reasons, the validator's refusals and a card's
 * constraints all say it in these words.
 */
function mobilityOf(scene: Scene, object: SceneObject, role: SpatialRoleType, underDisplay: ReadonlyMap<Id, Id>): { mobility: Mobility; why: string } {
  const support = object.support;
  if (support.kind === "wall") {
    const wall = walls(scene).find((w) => w.id === support.wallId);
    return { mobility: "wall-mounted", why: `it hangs on the ${wall?.label.toLowerCase() ?? "wall"}` };
  }
  if (support.kind === "ceiling") return { mobility: "ceiling-mounted", why: "it hangs from the ceiling" };
  if (support.kind === "object") {
    const carrier = scene.objects.find((o) => o.id === support.objectId);
    return { mobility: "carried", why: `it stands on the ${carrier?.label.toLowerCase() ?? "piece under it"}, and moves only with it` };
  }
  if (object.dimensions[1] * object.transform.scale[1] <= FLAT) return { mobility: "anchored", why: "it lies flat under the furniture" };
  const display = underDisplay.get(object.id);
  if (display) {
    const screen = scene.objects.find((o) => o.id === display)!;
    return { mobility: "anchored", why: `the ${screen.label.toLowerCase()} hangs above it` };
  }
  const wall = wallBehind(scene, object);
  if (role === "STORAGE" && wall) return { mobility: "anchored", why: `it is storage standing against the ${wall.label.toLowerCase()}` };
  if (role === "SLEEPING") return { mobility: "anchored", why: "a bed is not rearranged by a room layout" };
  return { mobility: "movable", why: "it stands on the floor, free to move and turn" };
}

/** The reason a piece stays where it is, as a clause; null when a layout may move it. */
export const whyItStays = (role: SpatialRole): string | null => (role.mobility === "movable" ? null : role.reasons[role.reasons.length - 1]);
