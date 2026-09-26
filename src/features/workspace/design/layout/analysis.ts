import { findById, roomBounds, walls, wallFrame } from "@/scene/model/queries";
import type { Id, ObjectCategory, Relationship, Scene, Support, Vec2 } from "@/scene/model/types";
import { footprintOf, separation, type Footprint } from "../../ai/rules/spatial";
import { circulationOf, type Circulation } from "./circulation";
import { frontOf, isPassage, nearestWallOf, relationsOf, round, wallBehind } from "./geometry";
import { spatialRoles, type Mobility, type SpatialRole, type SpatialRoleType } from "./roles";

/**
 * The room as a plan.
 * ================================================================
 *
 * The spatial half of the design analysis: what stands where, how big it is,
 * what it is for, what it may do, what it relates to and whether a person can
 * get round it. Read from the Scene and from nothing else; where the Scene is
 * silent — which way a table "faces", whether a window opens — so is this.
 */

export const LAYOUT_ANALYSIS_VERSION = "layout-analysis-0.1";

export interface PieceFacts {
  id: Id;
  label: string;
  category: ObjectCategory;
  role: SpatialRoleType;
  mobility: Mobility;
  support: Support["kind"];
  /** Base centre on the floor, metres. */
  position: Vec2;
  /** Turn about +Y, degrees, rounded to 0.1. */
  rotationDeg: number;
  /** Width × height × depth with scale applied, metres. */
  size: readonly [number, number, number];
  footprint: Footprint;
  /** The way it faces on the floor. */
  front: Vec2;
  /** The nearest wall and how far the piece stands off it. */
  wall: { id: Id; gap: number } | null;
  /** The wall it stands with its back against, when it does. */
  against: Id | null;
}

export interface LayoutAnalysis {
  version: typeof LAYOUT_ANALYSIS_VERSION;
  bounds: { min: Vec2; max: Vec2 };
  walls: readonly { id: Id; label: string; length: number; inward: Vec2; openings: readonly Id[] }[];
  openings: readonly { id: Id; label: string; kind: "window" | "door"; wallId: Id; width: number; sill: number; height: number; passage: boolean }[];
  roles: readonly SpatialRole[];
  pieces: readonly PieceFacts[];
  /** The relationships the room's geometry holds now, by the compiler's own rules. */
  relationships: readonly Relationship[];
  /** Recorded relationships the room no longer bears out (a piece dragged away since). */
  staleRelationships: readonly Id[];
  seating: { primary: Id | null; secondary: readonly Id[] };
  /** What the seating can be arranged around: a screen, and the table in front of the main seat. */
  focal: { display: Id | null; table: Id | null };
  circulation: Circulation;
  /** Floor pieces standing within 60 cm of each other, nearest first. */
  proximity: readonly { a: Id; b: Id; gap: number }[];
}

export function analyseLayout(scene: Scene): LayoutAnalysis {
  const bounds = roomBounds(scene);
  const roles = spatialRoles(scene);
  const roleOf = (id: Id) => roles.find((r) => r.id === id)!;
  const relationships = relationsOf(scene);
  const holds = (r: Relationship) => relationships.some((x) => x.subjectId === r.subjectId && x.predicate === r.predicate && x.objectId === r.objectId);

  const pieces = scene.objects.map((object): PieceFacts => {
    const f = footprintOf(object);
    const near = nearestWallOf(scene, f);
    const [w, h, d] = object.dimensions;
    const [sx, sy, sz] = object.transform.scale;
    return {
      id: object.id,
      label: object.label,
      category: object.category,
      role: roleOf(object.id).role,
      mobility: roleOf(object.id).mobility,
      support: object.support.kind,
      position: [object.transform.position[0], object.transform.position[2]],
      rotationDeg: round((object.transform.rotation[1] * 180) / Math.PI, 0.1),
      size: [round(w * sx, 0.001), round(h * sy, 0.001), round(d * sz, 0.001)],
      footprint: f,
      front: frontOf(object.transform.rotation[1]),
      wall: near ? { id: near.wall.id, gap: round(Math.max(0, near.gap), 0.001) } : null,
      against: wallBehind(scene, object)?.id ?? null,
    };
  });

  const floor = pieces.filter((p) => p.support === "floor" && p.size[1] > 0.05);
  const proximity: { a: Id; b: Id; gap: number }[] = [];
  for (let i = 0; i < floor.length; i++) {
    for (let j = i + 1; j < floor.length; j++) {
      const gap = separation(floor[i].footprint, floor[j].footprint);
      if (gap < 0.6) proximity.push({ a: floor[i].id, b: floor[j].id, gap: round(Math.max(0, gap), 0.001) });
    }
  }
  proximity.sort((x, y) => x.gap - y.gap || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  const primary = roles.find((r) => r.role === "PRIMARY_SEATING")?.id ?? null;
  return {
    version: LAYOUT_ANALYSIS_VERSION,
    bounds: { min: [bounds.min[0], bounds.min[2]], max: [bounds.max[0], bounds.max[2]] },
    walls: walls(scene).map((wall) => {
      const frame = wallFrame(scene, wall);
      return { id: wall.id, label: wall.label, length: round(frame.length, 0.001), inward: frame.inward, openings: scene.openings.filter((o) => o.wallId === wall.id).map((o) => o.id) };
    }),
    openings: scene.openings.map((o) => ({ id: o.id, label: o.label, kind: o.kind, wallId: o.wallId, width: o.width, sill: o.sill, height: o.height, passage: isPassage(o) })),
    roles,
    pieces,
    relationships,
    staleRelationships: scene.relationships.filter((r) => !holds(r)).map((r) => r.id),
    seating: { primary, secondary: roles.filter((r) => r.role === "SECONDARY_SEATING").map((r) => r.id) },
    focal: { display: displayOf(scene), table: tableOf(scene, primary, relationships) },
    circulation: circulationOf(scene),
    proximity,
  };
}

/** A screen the room can be arranged around: the first television, when there is one. */
function displayOf(scene: Scene): Id | null {
  return scene.objects.find((o) => o.category === "television")?.id ?? null;
}

/**
 * The table the main seat is arranged round: the one the rules say stands in
 * front of it, else the nearest table within reach of its front.
 */
export function tableOf(scene: Scene, primary: Id | null, relationships: readonly Relationship[]): Id | null {
  if (!primary) return null;
  const tables = scene.objects.filter((o) => (o.category === "coffee-table" || o.category === "side-table") && o.support.kind === "floor");
  const recorded = relationships.find((r) => r.predicate === "in-front-of" && r.objectId === primary && tables.some((t) => t.id === r.subjectId));
  if (recorded) return recorded.subjectId;
  const seat = findById(scene.objects, primary)!;
  const near = tables
    .map((t) => ({ t, gap: separation(footprintOf(seat), footprintOf(t)) }))
    .filter(({ gap }) => gap < 1.2)
    .sort((a, b) => a.gap - b.gap || a.t.id.localeCompare(b.t.id))[0];
  return near?.t.id ?? null;
}
