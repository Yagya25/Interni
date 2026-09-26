import { findById, walls, wallFrame } from "@/scene/model/queries";
import type { Id, Vec2 } from "@/scene/model/types";
import { footprintOf } from "../ai/rules/spatial";
import { convexDistance, polygonOf, type Polygon } from "./geometry";
import { footprintInputs, openingInput, wallInput, withScale, type Knowledge } from "./provenance";
import { measurement, unavailable, type Measured, type MeasuredInput } from "./types";

/**
 * The plan distance between any two things in the room: pieces by their
 * turned footprints, walls by their interior faces, openings by their span
 * along the wall. 0 when they touch or overlap. A distance in plan: a
 * picture above a sofa is 0 from it.
 */
export function distanceBetween(k: Knowledge, a: Id, b: Id): Measured {
  if (a === b) return unavailable("a thing's distance from itself is not a measurement");
  const one = shapeOf(k, a);
  const two = shapeOf(k, b);
  if (typeof one === "string") return unavailable(one);
  if (typeof two === "string") return unavailable(two);
  const d = convexDistance(one.shape, two.shape);
  return measurement(d, "m", [a, b], withScale(k, [...one.inputs, ...two.inputs]), { rule: "plan-distance" });
}

export function shapeOf(k: Knowledge, id: Id): { shape: Polygon; inputs: MeasuredInput[] } | string {
  const { scene } = k;
  const object = findById(scene.objects, id);
  if (object) {
    const shape = polygonOf(footprintOf(object));
    if (!shape.every((v) => Number.isFinite(v[0]) && Number.isFinite(v[1]))) return `${object.label}'s footprint is not a usable shape`;
    return { shape, inputs: footprintInputs(k, object) };
  }
  const wall = findById(walls(scene), id);
  if (wall) return { shape: [wall.start, wall.end], inputs: [wallInput(k, wall)] };
  const opening = findById(scene.openings, id);
  if (opening) {
    const host = findById(walls(scene), opening.wallId);
    if (!host) return `${opening.label} is in a wall the room does not have`;
    const { direction } = wallFrame(scene, host);
    const at = (t: number): Vec2 => [host.start[0] + direction[0] * t, host.start[1] + direction[1] * t];
    return { shape: [at(opening.offset - opening.width / 2), at(opening.offset + opening.width / 2)], inputs: [openingInput(k, opening, "width"), wallInput(k, host)] };
  }
  return `there is nothing called ${id} in the room`;
}
