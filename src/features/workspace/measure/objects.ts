import type { Basis } from "@/scene/compile/intermediate";
import { walls } from "@/scene/model/queries";
import type { Id, Scene, SceneObject, Vec2, WallSurface } from "@/scene/model/types";
import { footprintOf, hasFront } from "../ai/rules/spatial";
import { obstaclesOf } from "../design/layout/circulation";
import { frontOf, gapToWall } from "../design/layout/geometry";
import { clearDepth, convexDistance, extentOf, isPolygon, polygonArea, polygonOf, type Blocker, type Polygon } from "./geometry";
import { footprintInputs, objectInput, roomInput, sizeInputs, supportInput, wallInput, withScale, type Knowledge } from "./provenance";
import { growing } from "./room";
import { measurement, unavailable, type Measured, type MeasuredInput } from "./types";

/**
 * Each piece, measured.
 * ================================================================
 *
 * Its size with its scale applied, its footprint turned as it stands, how
 * high it reaches, what it stands on, the wall nearest it, the piece nearest
 * it, and — for a piece with a front — how far the floor runs clear in front
 * of it and what ends it. All in plan, from the Scene as it now is.
 */

export interface Fact {
  value: boolean;
  basis: Basis;
  edited: boolean;
  sources: readonly string[];
}

/** What ends a clear run of floor: a piece, a wall, or the edge of the room where no wall was seen. */
export interface EndedBy {
  kind: "object" | "wall" | "edge";
  id: Id | null;
  label: string;
}

export interface ObjectMeasurements {
  id: Id;
  label: string;
  size: { width: Measured; depth: Measured; height: Measured };
  /** Axis-aligned extent in plan, across (X) and along (Z) the room, and how high it reaches. */
  bounds: { across: Measured; along: Measured; bottom: Measured; top: Measured };
  footprint: { polygon: Polygon; area: Measured } | null;
  /** Standing on the floor, as the reconstruction placed it. */
  onFloor: Fact;
  /** The wall nearest the piece, the gap to it, and whether that gap is too small to tell from touching. */
  wall: { wallId: Id; label: string; gap: Measured; touching: boolean } | null;
  /** The floor piece nearest a floor piece, and the true plan distance between them. */
  nearest: { id: Id; label: string; distance: Measured } | null;
  /** How far the floor runs clear straight out from the front of a piece with one. */
  front: { depth: Measured; endedBy: EndedBy } | null;
}

export function measureObjects(k: Knowledge): ObjectMeasurements[] {
  const floorPieces = obstaclesOf(k.scene).map(({ object, footprint }) => ({ object, polygon: polygonOf(footprint) }));
  return k.scene.objects.map((object) => measureObject(k, object, floorPieces));
}

type FloorPiece = { object: SceneObject; polygon: Polygon };

/** A piece's own size, its scale applied: width, depth and height, each as its evidence knows it. */
export function sizeOf(k: Knowledge, object: SceneObject): ObjectMeasurements["size"] {
  const [w, h, d] = sizeInputs(k, object);
  const axis = (i: 0 | 1 | 2, input: MeasuredInput): Measured => {
    const value = object.dimensions[i] * object.transform.scale[i];
    return Number.isFinite(value) && value > 0 ? measurement(value, "m", [object.id], withScale(k, [input]), { bound: input.bound, direct: true }) : unavailable("its size in the Scene is not a positive length");
  };
  return { width: axis(0, w), depth: axis(2, d), height: axis(1, h) };
}

function measureObject(k: Knowledge, object: SceneObject, floorPieces: readonly FloorPiece[]): ObjectMeasurements {
  const [w, h, d] = sizeInputs(k, object);
  const dims = object.dimensions.map((v, i) => v * object.transform.scale[i]);
  const valid = dims.every((v) => Number.isFinite(v) && v > 0) && object.transform.position.every(Number.isFinite) && Number.isFinite(object.transform.rotation[1]);
  const size = sizeOf(k, object);
  const support = supportInput(k, object);
  const onFloor: Fact = {
    value: object.support.kind === "floor" && Math.abs(object.transform.position[1]) < 1e-6,
    basis: support.basis,
    edited: support.edited,
    sources: support.sources,
  };
  if (!valid) {
    const no = unavailable("its size, position or turn in the Scene is not a usable number");
    return { id: object.id, label: object.label, size, bounds: { across: no, along: no, bottom: no, top: no }, footprint: null, onFloor, wall: null, nearest: null, front: null };
  }

  const plan = footprintInputs(k, object);
  const footprint = footprintOf(object);
  const polygon = polygonOf(footprint);
  const [x0, x1, z0, z1] = extentOf(polygon);
  const position = objectInput(k, object, "transform.position");
  const y0 = object.transform.position[1];

  return {
    id: object.id,
    label: object.label,
    size,
    bounds: {
      across: measurement(x1 - x0, "m", [object.id], withScale(k, plan), { bound: growing(plan), rule: "plan-extent" }),
      along: measurement(z1 - z0, "m", [object.id], withScale(k, plan), { bound: growing(plan), rule: "plan-extent" }),
      bottom: measurement(y0, "m", [object.id], withScale(k, [position])),
      top: measurement(y0 + dims[1], "m", [object.id], withScale(k, [position, h]), { bound: growing([position, h]) }),
    },
    footprint: isPolygon(polygon) ? { polygon, area: measurement(polygonArea(polygon), "m²", [object.id], withScale(k, [w, d]), { bound: growing([w, d]) }) } : null,
    onFloor,
    wall: nearestWall(k, object),
    nearest: nearestPiece(k, object, polygon, floorPieces),
    front: frontClear(k, object, floorPieces),
  };
}

function nearestWall(k: Knowledge, object: SceneObject): ObjectMeasurements["wall"] {
  const f = footprintOf(object);
  const own = object.support.kind === "wall" ? object.support.wallId : null;
  let best: { wall: WallSurface; gap: number } | null = null;
  for (const wall of walls(k.scene)) {
    const gap = gapToWall(k.scene, wall, f);
    // What hangs on a wall is measured to its own wall.
    if (own ? wall.id === own : !best || gap < best.gap - 1e-9) best = { wall, gap };
  }
  if (!best) return null;
  const gap = measurement(Math.max(0, best.gap), "m", [object.id, best.wall.id], withScale(k, [...footprintInputs(k, object), wallInput(k, best.wall)]), { rule: "wall-gap" });
  return { wallId: best.wall.id, label: best.wall.label, gap, touching: gap.available && gap.rounded === 0 };
}

function nearestPiece(k: Knowledge, object: SceneObject, polygon: Polygon, floorPieces: readonly FloorPiece[]): ObjectMeasurements["nearest"] {
  if (!floorPieces.some((p) => p.object.id === object.id)) return null;
  let best: { other: SceneObject; distance: number } | null = null;
  for (const p of floorPieces) {
    if (p.object.id === object.id) continue;
    const distance = convexDistance(polygon, p.polygon);
    if (!best || distance < best.distance - 1e-9) best = { other: p.object, distance };
  }
  if (!best) return null;
  return {
    id: best.other.id,
    label: best.other.label,
    distance: measurement(best.distance, "m", [object.id, best.other.id], withScale(k, [...footprintInputs(k, object), ...footprintInputs(k, best.other)]), { rule: "plan-distance" }),
  };
}

/** The clear floor straight out from the front of a floor piece that has one: legroom for a seat, access for storage. */
function frontClear(k: Knowledge, object: SceneObject, floorPieces: readonly FloorPiece[]): ObjectMeasurements["front"] {
  if (!hasFront(object) || !floorPieces.some((p) => p.object.id === object.id)) return null;
  return clearFrom(k, object, "front", floorPieces);
}

/** A face of a piece, in its own frame: its front (local +Z), its back, and its two sides. */
export type Face = "front" | "back" | "side-a" | "side-b";

/** How far the floor runs clear straight out from one face of a floor piece, and what ends it. */
function clearFrom(k: Knowledge, object: SceneObject, face: Face, floorPieces: readonly FloorPiece[]): { depth: Measured; endedBy: EndedBy } {
  const f = footprintOf(object);
  const front = frontOf(f.angle);
  const right: Vec2 = [Math.cos(f.angle), -Math.sin(f.angle)];
  const [out, reach, half]: [Vec2, number, number] =
    face === "front" ? [front, f.hz, f.hx] : face === "back" ? [[-front[0], -front[1]], f.hz, f.hx] : face === "side-a" ? [right, f.hx, f.hz] : [[-right[0], -right[1]], f.hx, f.hz];
  const blockers: Blocker<EndedBy>[] = [
    ...floorPieces.filter((p) => p.object.id !== object.id).map((p) => ({ what: { kind: "object" as const, id: p.object.id, label: p.object.label }, shape: p.polygon })),
    ...boundaryOf(k.scene).map((b) => ({ what: b.endedBy, shape: b.segment })),
  ];
  const clear = clearDepth({ origin: [f.cx + out[0] * reach, f.cz + out[1] * reach], forward: out, half }, blockers);
  if (!clear) return { depth: unavailable("nothing ends the floor on that side: the room is not closed"), endedBy: { kind: "edge", id: null, label: "nothing" } };
  return { depth: measurement(clear.depth, "m", [object.id, ...(clear.by.id ? [clear.by.id] : [])], withScale(k, [...footprintInputs(k, object), ...endInputs(k, clear.by)]), { rule: "clear-depth" }), endedBy: clear.by };
}

/** The clear floor out from each of a floor piece's four faces; null for a piece that does not stand on the floor. */
export function clearAround(k: Knowledge, object: SceneObject): Record<Face, { depth: Measured; endedBy: EndedBy }> | null {
  const floorPieces = obstaclesOf(k.scene).map(({ object, footprint }) => ({ object, polygon: polygonOf(footprint) }));
  if (!floorPieces.some((p) => p.object.id === object.id)) return null;
  return {
    front: clearFrom(k, object, "front", floorPieces),
    back: clearFrom(k, object, "back", floorPieces),
    "side-a": clearFrom(k, object, "side-a", floorPieces),
    "side-b": clearFrom(k, object, "side-b", floorPieces),
  };
}

/** The inputs of whatever ends a clear run. */
export function endInputs(k: Knowledge, end: EndedBy): MeasuredInput[] {
  if (end.kind === "object") {
    const other = k.scene.objects.find((o) => o.id === end.id);
    return other ? footprintInputs(k, other) : [];
  }
  if (end.kind === "wall") {
    const wall = walls(k.scene).find((w) => w.id === end.id);
    return wall ? [wallInput(k, wall)] : [];
  }
  return [roomInput(k, "width"), roomInput(k, "depth")];
}

/**
 * The room's edges, each as the wall standing on it or, where the
 * reconstruction left a side out (the one behind the camera), as the edge
 * of the room itself.
 */
export function boundaryOf(scene: Scene): { segment: readonly [Vec2, Vec2]; endedBy: EndedBy }[] {
  const fp = scene.room.footprint;
  const same = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  return fp.map((a, i) => {
    const b = fp[(i + 1) % fp.length];
    const wall = walls(scene).find((w) => (same(w.start, a) && same(w.end, b)) || (same(w.start, b) && same(w.end, a)));
    return {
      segment: [a, b] as const,
      endedBy: wall ? { kind: "wall" as const, id: wall.id, label: wall.label } : { kind: "edge" as const, id: null, label: "the edge of the room (no wall seen)" },
    };
  });
}
