import type { Id, Opening, Scene, SceneObject, Vec2, Vec3, WallSurface } from "./types";

/** Pure helpers for reading a Scene. No rendering concerns. */

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function roomBounds(scene: Scene): Bounds {
  const xs = scene.room.footprint.map((p) => p[0]);
  const zs = scene.room.footprint.map((p) => p[1]);
  return {
    min: [Math.min(...xs), 0, Math.min(...zs)],
    max: [Math.max(...xs), scene.room.height, Math.max(...zs)],
  };
}

export function roomCentroid(scene: Scene): Vec2 {
  const n = scene.room.footprint.length;
  const sum = scene.room.footprint.reduce<[number, number]>(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1]],
    [0, 0],
  );
  return [sum[0] / n, sum[1] / n];
}

export function walls(scene: Scene): WallSurface[] {
  return scene.surfaces.filter((s): s is WallSurface => s.kind === "wall");
}

export function findById<T extends { id: Id }>(items: readonly T[], id: Id): T | undefined {
  return items.find((item) => item.id === id);
}

export interface WallFrame {
  length: number;
  /** Unit vector along the wall, start → end, on the XZ plane. */
  direction: Vec2;
  /** Unit vector pointing into the room. */
  inward: Vec2;
}

export function wallFrame(scene: Scene, wall: WallSurface): WallFrame {
  const dx = wall.end[0] - wall.start[0];
  const dz = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dz);
  const direction: Vec2 = [dx / length, dz / length];
  // Pick whichever perpendicular points towards the room centroid.
  const [cx, cz] = roomCentroid(scene);
  const mx = (wall.start[0] + wall.end[0]) / 2;
  const mz = (wall.start[1] + wall.end[1]) / 2;
  let inward: Vec2 = [-direction[1], direction[0]];
  if ((cx - mx) * inward[0] + (cz - mz) * inward[1] < 0) inward = [-inward[0], -inward[1]];
  return { length, direction, inward };
}

/** Centre of an opening on the wall's interior face, in world space. */
export function openingCenter(scene: Scene, opening: Opening): Vec3 {
  const wall = findById(walls(scene), opening.wallId);
  if (!wall) throw new Error(`Opening ${opening.id} references missing wall ${opening.wallId}`);
  const { direction } = wallFrame(scene, wall);
  return [
    wall.start[0] + direction[0] * opening.offset,
    opening.sill + opening.height / 2,
    wall.start[1] + direction[1] * opening.offset,
  ];
}

/** All materials actually referenced by the scene, deduplicated. */
export function usedMaterialIds(scene: Scene): Set<Id> {
  const ids = new Set<Id>();
  scene.surfaces.forEach((s) => ids.add(s.materialId));
  scene.openings.forEach((o) => {
    ids.add(o.frameMaterialId);
    ids.add(o.panelMaterialId);
  });
  scene.objects.forEach((o) => Object.values(o.materials).forEach((id) => ids.add(id)));
  return ids;
}

/** World-space centre of an object's bounding box, ignoring rotation. */
export function objectCenter(object: SceneObject): Vec3 {
  const [x, y, z] = object.transform.position;
  return [x, y + (object.dimensions[1] * object.transform.scale[1]) / 2, z];
}

/**
 * Radius of the circle that contains an object's plan footprint, scale
 * included. The editor draws its rotation ring on this, so the ring is
 * always just clear of the piece it turns.
 */
export function footprintRadius(object: SceneObject): number {
  const [w, , d] = object.dimensions;
  const [sx, , sz] = object.transform.scale;
  return Math.hypot(w * sx, d * sz) / 2;
}
