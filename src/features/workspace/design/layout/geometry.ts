import { PRIORS_BY_CATEGORY, type CategoryPrior } from "@/scene/compile/vocabulary";
import { deriveRelationships, type RelationInput } from "@/scene/compile/relationships";
import { findById, openingCenter, walls, wallFrame } from "@/scene/model/queries";
import type { Id, ObjectCategory, Opening, Relationship, Scene, SceneObject, Vec2, Vec3, WallSurface } from "@/scene/model/types";
import { distanceToWall, footprintOf, halfAlong, SPACING, separation, type Footprint } from "../../ai/rules/spatial";

/**
 * Plan geometry for layouts.
 * ================================================================
 *
 * Built on the command layer's own spatial primitives (`spatial.ts`:
 * footprints, separating axes, wall distances) and the compiler's own
 * relationship rules, so a layout reasons about the room with the same
 * geometry a single command does — there is no second collision model.
 *
 * Frames as in `spatial.ts`: +Y up, metres; a piece turned by `rotation[1]`
 * has its front (local +Z) along (sin a, cos a) on the floor.
 */

export interface Pose {
  at: Vec3;
  rotationY: number;
}

export const poseOf = (o: SceneObject): Pose => ({ at: o.transform.position, rotationY: o.transform.rotation[1] });

/** The floor direction a piece turned by `angle` faces. */
export const frontOf = (angle: number): Vec2 => [Math.sin(angle), Math.cos(angle)];

/** The turn about +Y that points a front along `dir`. */
export const angleOf = (dir: Vec2) => Math.atan2(dir[0], dir[1]);

/** An angle brought into (−π, π]. */
export function wrap(a: number) {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/** The smallest turn between two headings, 0..π. */
export const turnBetween = (a: number, b: number) => Math.abs(wrap(a - b));

/** Whether a category stands with its back to a wall when it stands by one (the compiler's own table). */
export function backToWall(category: ObjectCategory): boolean {
  const prior = (PRIORS_BY_CATEGORY as Partial<Record<ObjectCategory, CategoryPrior>>)[category];
  // The demonstration room's categories the reconstruction vocabulary has no prior for.
  return prior?.backToWall ?? category === "sideboard";
}

// ---------------------------------------------------------------------------
// Walls

/** How far a footprint stands off a wall, inward: 0 is touching it, negative is through it. */
export function gapToWall(scene: Scene, wall: WallSurface, f: Footprint): number {
  const { inward } = wallFrame(scene, wall);
  return distanceToWall(wall, [f.cx, 0, f.cz]) - halfAlong(f, inward);
}

/** The wall a footprint is nearest to, and its gap to it. */
export function nearestWallOf(scene: Scene, f: Footprint): { wall: WallSurface; gap: number } | null {
  let best: { wall: WallSurface; gap: number } | null = null;
  for (const wall of walls(scene)) {
    const gap = gapToWall(scene, wall, f);
    if (!best || gap < best.gap - 1e-9) best = { wall, gap };
  }
  return best;
}

/**
 * The wall a floor piece stands with its back against, at a pose: the
 * compiler's rule (a back-to-wall category, snug to the wall) read on the
 * room as it now is, so a sofa pulled into the room is no longer against it.
 */
export function wallBehind(scene: Scene, object: SceneObject, pose: Pose = poseOf(object)): WallSurface | null {
  if (object.support.kind !== "floor" || !backToWall(object.category)) return null;
  const f = footprintOf(object, pose.at, pose.rotationY);
  const front = frontOf(pose.rotationY);
  for (const wall of walls(scene)) {
    const { inward } = wallFrame(scene, wall);
    if (front[0] * inward[0] + front[1] * inward[1] < Math.cos(Math.PI / 6)) continue;
    if (gapToWall(scene, wall, f) <= SPACING.againstWall) return wall;
  }
  return null;
}

/** The facing angles squared to the room: straight out from each wall. */
export function squaredAngles(scene: Scene): number[] {
  const angles: number[] = [];
  for (const wall of walls(scene)) {
    const { inward } = wallFrame(scene, wall);
    for (const dir of [inward, [-inward[0], -inward[1]] as Vec2]) {
      const a = round(angleOf(dir), 0.0001);
      if (!angles.some((b) => turnBetween(a, b) < 1e-3)) angles.push(a);
    }
  }
  return angles.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Openings a person walks through

/** Heuristic thresholds for what counts as a way through, and the floor kept clear in front of it. */
export const PASSAGE = {
  /** An opening whose bottom is at most this high is walked through, whatever it was named. */
  sill: 0.05,
  /** …and at least this tall. */
  height: 1.8,
  /** The floor kept clear in front of it, straight out into the room. */
  depth: 0.9,
  /** How far a piece may stand into that floor before it counts as in the way. */
  tolerance: 0.1,
} as const;

export interface PassageZone {
  opening: Opening;
  /** The clear floor in front of the opening, as a footprint. */
  zone: Footprint;
}

export const isPassage = (o: Opening) => o.sill <= PASSAGE.sill && o.height >= PASSAGE.height;

/** The floor in front of every opening a person can walk through. Windows above the floor have none. */
export function passageZones(scene: Scene): PassageZone[] {
  return scene.openings.filter(isPassage).flatMap((opening) => {
    const wall = findById(walls(scene), opening.wallId);
    if (!wall) return [];
    const { direction, inward } = wallFrame(scene, wall);
    const c = openingCenter(scene, opening);
    const zone: Footprint = {
      cx: c[0] + (inward[0] * PASSAGE.depth) / 2,
      cz: c[2] + (inward[1] * PASSAGE.depth) / 2,
      hx: opening.width / 2,
      hz: PASSAGE.depth / 2,
      // Local X along the wall: (cos a, −sin a) = direction.
      angle: Math.atan2(-direction[1], direction[0]),
      y0: 0,
      y1: opening.height,
    };
    return [{ opening, zone }];
  });
}

/** How deep a footprint stands into a zone, in metres; 0 when clear of it. */
export const intrusion = (f: Footprint, zone: Footprint) => Math.max(0, -separation(f, zone));

// ---------------------------------------------------------------------------
// Points and footprints

/** Plan distance from a point to a footprint: 0 on or inside it. */
export function distanceToFootprint(x: number, z: number, f: Footprint): number {
  const dx = x - f.cx;
  const dz = z - f.cz;
  const lx = dx * Math.cos(f.angle) - dz * Math.sin(f.angle);
  const lz = dx * Math.sin(f.angle) + dz * Math.cos(f.angle);
  return Math.hypot(Math.max(0, Math.abs(lx) - f.hx), Math.max(0, Math.abs(lz) - f.hz));
}

/** The rectangle straight in front of a footprint, `depth` deep: where a seated person's legs go. */
export function frontZone(f: Footprint, depth: number): Footprint {
  const front = frontOf(f.angle);
  return { ...f, cx: f.cx + front[0] * (f.hz + depth / 2), cz: f.cz + front[1] * (f.hz + depth / 2), hz: depth / 2 };
}

// ---------------------------------------------------------------------------
// Relationships, as the room now stands

/**
 * What the compiler's rules read of each piece: its front from its turn, the
 * wall it is on or stands against. `override` places one piece at a pose the
 * planner is considering, without building a scene for it.
 */
export function relationInputs(scene: Scene, override?: { id: Id; pose: Pose }): RelationInput[] {
  return scene.objects.map((object) => {
    const placed = override && override.id === object.id ? atPose(object, override.pose) : object;
    const wall = wallBehind(scene, placed);
    return {
      object: placed,
      front: frontOf(placed.transform.rotation[1]),
      against: wall?.id ?? null,
      onWall: placed.support.kind === "wall" ? placed.support.wallId : null,
    };
  });
}

/**
 * The room's relationships recomputed from its current geometry, by the
 * compiler's own rules. On the room as reconstructed this is the recorded
 * list; after a layout it is what that layout actually leaves true.
 */
export const relationsOf = (scene: Scene): Relationship[] => deriveRelationships(relationInputs(scene));

/** The same object, standing at a pose. */
export const atPose = (object: SceneObject, pose: Pose): SceneObject => ({
  ...object,
  transform: { ...object.transform, position: pose.at, rotation: [object.transform.rotation[0], pose.rotationY, object.transform.rotation[2]] },
});

export const round = (value: number, step: number) => {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(value / step) * step).toFixed(decimals));
};
