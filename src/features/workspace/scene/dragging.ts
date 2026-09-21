import { onRing, turnsOnFloor } from "@/scene/model/editing";
import { findById, wallFrame, walls } from "@/scene/model/queries";
import type { Scene, SceneObject, Vec3 } from "@/scene/model/types";

/**
 * Taking hold of a piece.
 *
 * There is one handle, and it is the ring the renderer draws around
 * whatever is selected: inside it the piece slides, on it the piece turns.
 * No gizmo, no axis arrows, no mode to switch — the affordance is the same
 * shape an architect would draw to show a swing.
 *
 * A piece is free in the plane the room gives it: furniture slides across
 * the floor it stands on, something resting on a table stays on the table,
 * and a picture slides along its own wall. The plane is chosen once, when
 * the grip is taken, so a piece can never leap onto a different surface
 * part-way through.
 */

export interface MoveGrip {
  mode: "move";
  objectId: string;
  /** The plane the piece is free to move in. */
  origin: Vec3;
  normal: Vec3;
  /** Where the pointer first met the plane, and where the piece was then. */
  grabbedAt: Vec3;
  from: Vec3;
}

export interface TurnGrip {
  mode: "turn";
  objectId: string;
  origin: Vec3;
  normal: Vec3;
  /** The bearing the grip was taken at, and the piece's angle then. */
  fromBearing: number;
  fromRotation: number;
}

export type Grip = MoveGrip | TurnGrip;

/** Turning snaps to this many degrees while Shift is held. */
const SNAP = 15;

export function planeFor(scene: Scene, object: SceneObject): { origin: Vec3; normal: Vec3 } | null {
  const origin = object.transform.position;
  if (object.support.kind === "wall") {
    const wall = findById(walls(scene), object.support.wallId);
    if (!wall) return null;
    const { inward } = wallFrame(scene, wall);
    return { origin, normal: [inward[0], 0, inward[1]] };
  }
  // Floor, ceiling and things resting on other things all move level.
  return { origin, normal: [0, 1, 0] };
}

/** The horizontal plane a piece's ring lies in, when it has one. */
export function ringPlaneFor(object: SceneObject): { origin: Vec3; normal: Vec3 } | null {
  return turnsOnFloor(object) ? { origin: object.transform.position, normal: [0, 1, 0] } : null;
}

export function grips(object: SceneObject, pointerAt: Vec3): boolean {
  return onRing(object, pointerAt[0], pointerAt[2]);
}

export function beginMove(scene: Scene, object: SceneObject, pointerAt: Vec3): MoveGrip | null {
  const plane = planeFor(scene, object);
  if (!plane) return null;
  return {
    mode: "move",
    objectId: object.id,
    origin: plane.origin,
    normal: plane.normal,
    grabbedAt: pointerAt,
    from: object.transform.position,
  };
}

export function beginTurn(object: SceneObject, pointerAt: Vec3): TurnGrip {
  return {
    mode: "turn",
    objectId: object.id,
    origin: object.transform.position,
    normal: [0, 1, 0],
    fromBearing: bearing(object.transform.position, pointerAt),
    fromRotation: object.transform.rotation[1],
  };
}

/** Where the piece should now stand, keeping the grip the pointer took. */
export function positionFrom(grip: MoveGrip, pointerAt: Vec3): Vec3 {
  return [
    grip.from[0] + (pointerAt[0] - grip.grabbedAt[0]),
    grip.from[1] + (pointerAt[1] - grip.grabbedAt[1]),
    grip.from[2] + (pointerAt[2] - grip.grabbedAt[2]),
  ];
}

/**
 * The angle the piece should now stand at. The ring follows the hand
 * exactly: whatever point of it was taken hold of stays under the pointer.
 */
export function rotationFrom(grip: TurnGrip, pointerAt: Vec3, snap: boolean): number {
  // A bearing measured from +X towards +Z runs the opposite way round to a
  // rotation about +Y, hence the subtraction.
  const turned = grip.fromRotation - (bearing(grip.origin, pointerAt) - grip.fromBearing);
  if (!snap) return turned;
  const step = (SNAP * Math.PI) / 180;
  return Math.round(turned / step) * step;
}

const bearing = (centre: Vec3, point: Vec3) => Math.atan2(point[2] - centre[2], point[0] - centre[0]);
