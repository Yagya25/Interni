import { carriedBy, moveWithLoad, type LightChange, type SceneOperation } from "@/scene/model/operations";
import { roomBounds } from "@/scene/model/queries";
import type {
  ArtificialLight,
  Id,
  Material,
  Scene,
  SceneObject,
  Surface,
  Vec3,
} from "@/scene/model/types";

/**
 * Every edit the workspace can make, as a named intent.
 *
 * Components ask for an intent and hand it to the store; none of them build
 * operations inline, so there is one place to read to know what this product
 * can do to a room, and one place to change when an operation changes shape.
 */
export interface Intent {
  /**
   * Usually one operation. A few acts are genuinely several — taking away a
   * table takes away what stood on it — and those travel together so they
   * undo together.
   */
  operations: readonly SceneOperation[];
  /** What the person did, for the history. */
  label: string;
  /** Set for continuous gestures so they fold into one undo step. */
  mergeKey?: string;
}

// ---------------------------------------------------------------------------
// Objects

/** Moving a piece carries what stands on it: a table takes its vase along. */
export function moveObject(scene: Scene, object: SceneObject, to: Vec3): Intent {
  return {
    operations: moveWithLoad(scene, object, containedIn(scene, object, to), object.transform.rotation[1]),
    label: `Move ${object.label.toLowerCase()}`,
    mergeKey: `move:${object.id}`,
  };
}

export function rotateObject(scene: Scene, object: SceneObject, rotationY: number): Intent {
  return {
    operations: moveWithLoad(
      scene,
      object,
      // Turning inside a corner can push a piece through the wall.
      containedIn(scene, object, object.transform.position, rotationY),
      rotationY,
    ),
    label: `Turn ${object.label.toLowerCase()}`,
    mergeKey: `rotate:${object.id}`,
  };
}

export function resizeObject(object: SceneObject, scale: Vec3): Intent {
  return {
    operations: [{ kind: "scale", objectId: object.id, to: scale }],
    label: `Resize ${object.label.toLowerCase()}`,
    mergeKey: `scale:${object.id}`,
  };
}

/**
 * Taking a piece away takes what it was carrying with it. A coffee table
 * that vanishes leaving its vase in mid-air is not a model of anything;
 * the whole stack goes, innermost first, and comes back together on undo.
 */
export function removeObject(scene: Scene, object: SceneObject): Intent {
  const carried = carriedBy(scene, object.id);
  return {
    operations: [
      ...carried.map((held): SceneOperation => ({ kind: "remove", objectId: held.id })),
      { kind: "remove", objectId: object.id },
    ],
    label:
      carried.length > 0
        ? `Remove ${object.label.toLowerCase()} and ${carried.length} on it`
        : `Remove ${object.label.toLowerCase()}`,
  };
}

// ---------------------------------------------------------------------------
// Materials
//
// A material named in the library is shared: painting a wall with it paints
// every wall that uses it, which is what "this is the same paint" means.
// Adjusting a colour or a finish is different — it belongs to the one piece
// being adjusted — so it forks a material of its own, keyed to that piece
// and slot, and later adjustments reuse that fork rather than stacking up.

const forkId = (ownerId: Id, slot: string) => `${ownerId}:${slot}`;
const EDITED = " (edited)";

export function adjust(base: Material, ownerId: Id, slot: string, change: Partial<Material>): Material {
  const name = base.name.endsWith(EDITED) ? base.name : base.name + EDITED;
  return { ...base, ...change, id: forkId(ownerId, slot), name };
}

export function restyleSlot(object: SceneObject, slot: string, to: Material): Intent {
  return {
    operations: [{ kind: "restyle", objectId: object.id, slot, to }],
    label: `${object.label}: ${to.name}`,
  };
}

export function adjustSlot(
  object: SceneObject,
  slot: string,
  base: Material,
  change: Partial<Material>,
  what: string,
): Intent {
  return {
    operations: [
      { kind: "restyle", objectId: object.id, slot, to: adjust(base, object.id, slot, change) },
    ],
    label: `${object.label}: ${what}`,
    mergeKey: `restyle:${object.id}:${slot}:${what}`,
  };
}

export function resurface(surface: Surface, to: Material): Intent {
  return {
    operations: [{ kind: "resurface", surfaceId: surface.id, to }],
    label: `${surface.label}: ${to.name}`,
  };
}

export function adjustSurface(
  surface: Surface,
  base: Material,
  change: Partial<Material>,
  what: string,
): Intent {
  return {
    operations: [
      { kind: "resurface", surfaceId: surface.id, to: adjust(base, surface.id, "surface", change) },
    ],
    label: `${surface.label}: ${what}`,
    mergeKey: `resurface:${surface.id}:${what}`,
  };
}

// ---------------------------------------------------------------------------
// Light

export function setTimeOfDay(lightId: Id, timeOfDay: number): Intent {
  return {
    operations: [{ kind: "relight", lightId, to: { timeOfDay } }],
    label: "Time of day",
    mergeKey: `daylight:${lightId}`,
  };
}

export function changeLamp(light: ArtificialLight, to: LightChange, what: string): Intent {
  return {
    operations: [{ kind: "relight", lightId: light.id, to }],
    label: `${light.label}: ${what}`,
    mergeKey: to.on === undefined ? `lamp:${light.id}:${what}` : undefined,
  };
}

// ---------------------------------------------------------------------------

/**
 * Keep a piece inside the room it belongs to. The footprint is the object's
 * plan rectangle turned by its own rotation, so a sofa swung to 45° stops
 * further from the wall than one square to it.
 */
function containedIn(scene: Scene, object: SceneObject, to: Vec3, rotationY?: number): Vec3 {
  const bounds = roomBounds(scene);
  const angle = rotationY ?? object.transform.rotation[1];
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const [w, h, d] = object.dimensions;
  const [sx, sy, sz] = object.transform.scale;
  const halfX = (cos * w * sx + sin * d * sz) / 2;
  const halfZ = (sin * w * sx + cos * d * sz) / 2;
  // A piece hung on a wall also has to stay between the floor and ceiling;
  // one standing on something keeps whatever height that something gave it.
  const y =
    object.support.kind === "wall"
      ? clampSpan(to[1], 0, bounds.max[1] - h * sy)
      : to[1];
  return [
    clampSpan(to[0], bounds.min[0] + halfX, bounds.max[0] - halfX),
    y,
    clampSpan(to[2], bounds.min[2] + halfZ, bounds.max[2] - halfZ),
  ];
}

/** Clamp to a span, centring instead when the span has collapsed. */
function clampSpan(value: number, min: number, max: number) {
  if (min >= max) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}
