import { footprintRadius } from "./queries";
import type { SceneObject } from "./types";

/**
 * Rules the renderer and the editor have to agree on.
 *
 * The ring a piece is turned by is drawn by one and grabbed by the other,
 * so where it sits is defined once, here, rather than twice in terms that
 * could drift apart.
 */

/** How far clear of a piece's own footprint its ring sits, in metres. */
const CLEARANCE = 0.16;
/** How close to the ring counts as taking hold of it, in metres. */
const GRIP = 0.14;

/**
 * Whether a piece turns on a horizontal plane. Something hung on a wall
 * or dropped from the ceiling does not, so it gets no ring and is
 * adjusted by its readings instead.
 */
export const turnsOnFloor = (object: SceneObject) =>
  object.support.kind === "floor" || object.support.kind === "object";

export const ringRadius = (object: SceneObject) => footprintRadius(object) + CLEARANCE;

/**
 * Whether a point on the piece's own plane is on its ring. The tolerance
 * grows a little with the ring so a large piece is no harder to take hold
 * of than a small one.
 */
export function onRing(object: SceneObject, x: number, z: number) {
  const [cx, , cz] = object.transform.position;
  const radius = ringRadius(object);
  const grip = Math.max(GRIP, radius * 0.12);
  return Math.abs(Math.hypot(x - cx, z - cz) - radius) <= grip;
}
