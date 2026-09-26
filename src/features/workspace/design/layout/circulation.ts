import { roomBounds } from "@/scene/model/queries";
import type { Id, Scene, SceneObject } from "@/scene/model/types";
import { footprintOf, type Footprint } from "../../ai/rules/spatial";
import { distanceToFootprint, intrusion, PASSAGE, passageZones } from "./geometry";
import { FLAT, isSeat } from "./roles";

/**
 * Can a person get round the room?
 * ================================================================
 *
 * A deterministic design heuristic, and nothing more: the floor is laid out
 * as a 10 cm grid, the pieces standing on it are taken as obstacles (a rug
 * is walked over), and a cell is walkable when a 60 cm wide path could pass
 * through it — at least 30 cm from every piece and every wall. The walkable
 * floor is what can be reached that way from a doorway.
 *
 * It is not an accessibility assessment. It knows nothing of door swings,
 * wheelchair turning circles, building codes or how the room is actually
 * used; it measures whether the furniture leaves a path, and where.
 */

export const CIRCULATION = {
  version: "circulation-0.1",
  /** Grid spacing, metres. */
  cell: 0.1,
  /** Half the width of the narrowest path counted as walkable. */
  clearance: 0.3,
  /** How close a walkable cell must come to a seat's footprint for someone to sit in it. */
  reach: 0.35,
  /** Anything lower than this is walked over. */
  obstacleHeight: FLAT,
} as const;

export interface Circulation {
  version: typeof CIRCULATION.version;
  /** Floor not under any piece, m². */
  openArea: number;
  /** Floor under pieces, m²: their union, so two touching pieces are not counted twice. */
  occupiedArea: number;
  /** Floor a person can walk on, reached from a way in, m². */
  walkableArea: number;
  /** Where the walkable floor was reached from: a doorway, or — when the room has none — its largest open region. */
  from: "passage" | "largest-region";
  passages: readonly { openingId: Id; reachable: boolean; blockedBy: readonly Id[] }[];
  seats: readonly { id: Id; reachable: boolean }[];
}

/** The pieces a person walks round, with their footprints. */
export function obstaclesOf(scene: Scene): { object: SceneObject; footprint: Footprint }[] {
  return scene.objects
    .filter((o) => o.support.kind === "floor" && o.dimensions[1] * o.transform.scale[1] > CIRCULATION.obstacleHeight)
    .map((object) => ({ object, footprint: footprintOf(object) }));
}

export function circulationOf(scene: Scene): Circulation {
  const { cell, clearance, reach } = CIRCULATION;
  const b = roomBounds(scene);
  const nx = Math.max(1, Math.round((b.max[0] - b.min[0]) / cell));
  const nz = Math.max(1, Math.round((b.max[2] - b.min[2]) / cell));
  const sx = (b.max[0] - b.min[0]) / nx;
  const sz = (b.max[2] - b.min[2]) / nz;
  const x = (i: number) => b.min[0] + (i + 0.5) * sx;
  const z = (k: number) => b.min[2] + (k + 0.5) * sz;
  const obstacles = obstaclesOf(scene);
  const zones = passageZones(scene);

  const under = new Uint8Array(nx * nz);
  const passable = new Uint8Array(nx * nz);
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const c = k * nx + i;
      const px = x(i);
      const pz = z(k);
      let d = Infinity;
      for (const { footprint } of obstacles) d = Math.min(d, distanceToFootprint(px, pz, footprint));
      if (d === 0) under[c] = 1;
      const wall = Math.min(px - b.min[0], b.max[0] - px, pz - b.min[2], b.max[2] - pz);
      if (d >= clearance && wall >= clearance) passable[c] = 1;
    }
  }

  // Seeds: walkable cells in front of a way in; without one, the largest open region.
  const inZone = (c: number, zone: Footprint) => distanceToFootprint(x(c % nx), z(Math.floor(c / nx)), zone) === 0;
  let seeds: number[] = [];
  for (let c = 0; c < nx * nz; c++) {
    if (passable[c] && zones.some(({ zone }) => inZone(c, zone))) seeds.push(c);
  }
  const from: Circulation["from"] = zones.length > 0 && seeds.length > 0 ? "passage" : "largest-region";
  if (from === "largest-region") seeds = largestRegion(passable, nx, nz);
  const walkable = flood(passable, nx, nz, seeds);

  const area = sx * sz;
  const count = (grid: Uint8Array) => grid.reduce((n, v) => n + v, 0);
  const walkableCells = [...walkable.keys()].filter((c) => walkable[c]);

  return {
    version: CIRCULATION.version,
    openArea: round(count(under.map((v) => 1 - v)) * area),
    occupiedArea: round(count(under) * area),
    walkableArea: round(walkableCells.length * area),
    from,
    passages: zones.map(({ opening, zone }) => ({
      openingId: opening.id,
      reachable: from === "passage" && seeds.some((c) => inZone(c, zone)),
      blockedBy: obstacles.filter(({ footprint }) => intrusion(footprint, zone) > PASSAGE.tolerance).map(({ object }) => object.id),
    })),
    seats: obstacles
      .filter(({ object }) => isSeat(object))
      .map(({ object, footprint }) => ({
        id: object.id,
        reachable: walkableCells.some((c) => distanceToFootprint(x(c % nx), z(Math.floor(c / nx)), footprint) <= clearance + reach),
      })),
  };
}

/** Cells reachable from the seeds through passable cells, four ways. */
function flood(passable: Uint8Array, nx: number, nz: number, seeds: readonly number[]): Uint8Array {
  const seen = new Uint8Array(nx * nz);
  const queue = [...seeds];
  for (const s of seeds) seen[s] = 1;
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head];
    const i = c % nx;
    const k = Math.floor(c / nx);
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i + di;
      const nk = k + dk;
      if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
      const n = nk * nx + ni;
      if (passable[n] && !seen[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  return seen;
}

/** The largest connected walkable region's first cell, found in grid order; ties go to the first found. */
function largestRegion(passable: Uint8Array, nx: number, nz: number): number[] {
  const labelled = new Uint8Array(nx * nz);
  let best: number[] = [];
  let bestSize = 0;
  for (let c = 0; c < nx * nz; c++) {
    if (!passable[c] || labelled[c]) continue;
    const region = flood(passable, nx, nz, [c]);
    let size = 0;
    for (let n = 0; n < region.length; n++) {
      if (region[n]) {
        labelled[n] = 1;
        size++;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = [c];
    }
  }
  return best;
}

const round = (m2: number) => Math.round(m2 * 1000) / 1000;
