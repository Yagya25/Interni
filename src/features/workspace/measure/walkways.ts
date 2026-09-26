import { walls, wallFrame } from "@/scene/model/queries";
import type { Id, Opening, Scene, Vec2 } from "@/scene/model/types";
import { CIRCULATION, obstaclesOf } from "../design/layout/circulation";
import { isPassage } from "../design/layout/geometry";
import { contains, convexDistance, extentOf, isPolygon, pointToPolygon, pointToSegment, polygonOf, type Polygon, type Segment } from "./geometry";
import { boundaryOf, endInputs, type EndedBy } from "./objects";
import { openingInput, withScale, type Knowledge } from "./provenance";
import { measurement, type Measured } from "./types";

/**
 * How wide the way is, from a doorway to a piece.
 * ================================================================
 *
 * The floor is laid out as a 5 cm grid, and every cell knows how far it is
 * from the nearest standing piece or wall: a path twice that wide could pass
 * through it. A doorway is a gap in its wall, so a person comes in between
 * its jambs; a route starts on the doorway's threshold. Of every route from
 * a doorway to the piece, the widest is the one whose narrowest point is
 * widest, and that narrowest point — where it is, and what bounds it — is
 * the walkway's width. The piece walked to is not an obstacle on the way to
 * itself: a route ends where a person's centre comes within reach of it
 * (the circulation heuristic's reach, 35 cm).
 *
 * It answers "how wide is the way to the sofa?" and "is there at least
 * 80 cm?", not whether the room meets an accessibility standard: it knows
 * nothing of door swings or turning circles. The grid cannot resolve less
 * than its own step, so no width is shown finer than 5 cm.
 */

export const WALKWAY = {
  version: "walkway-0.1",
  /** Grid spacing, metres. */
  cell: 0.05,
  /** How close a person's centre must come to a piece to have reached it. */
  reach: CIRCULATION.reach,
} as const;

export type Walkway =
  | {
      reachable: true;
      to: Id;
      /** The doorway the widest route starts at. */
      from: Id;
      /** The narrowest point on the widest route. */
      width: Measured;
      at: Vec2;
      /** What bounds the route there: one thing, or the two it passes between. */
      between: readonly EndedBy[];
      /** The narrowest point is the doorway itself, on its threshold. */
      atDoorway: boolean;
    }
  | { reachable: false; to: Id; reason: string };

interface Thing {
  end: EndedBy;
  /** A piece's footprint, or a stretch of wall. */
  shape: Polygon;
  distance: (p: Vec2) => number;
  /** A stretch of wall that ends at a doorway: its frame, where the route passes closest to that end. */
  frames?: readonly { at: Vec2; label: string }[];
}

/** The room as the grid sees it: for each cell, the nearest two things and how far they are. Built once per Scene. */
interface Field {
  nx: number;
  at: (c: number) => Vec2;
  things: readonly Thing[];
  /** Cell inside the room. */
  inside: Uint8Array;
  near: Float64Array;
  nearest: Int32Array;
  second: Float64Array;
  /** The doorway whose threshold a cell lies on, or −1. */
  threshold: Int16Array;
  doorways: readonly Opening[];
}

const fields = new WeakMap<Scene, Field | string>();

function fieldOf(scene: Scene): Field | string {
  let field = fields.get(scene);
  if (field === undefined) fields.set(scene, (field = buildField(scene)));
  return field;
}

function buildField(scene: Scene): Field | string {
  const room = scene.room.footprint;
  if (!isPolygon(room)) return "the room's footprint is not a closed outline with an area";
  const doorways = scene.openings.filter(isPassage);
  if (!doorways.length) return "the room has no doorway to walk in from";
  const spans = doorways.map((o) => spanOf(scene, o));

  const things: Thing[] = [
    ...obstaclesOf(scene).map(({ object, footprint }) => {
      const polygon = polygonOf(footprint);
      return { end: { kind: "object" as const, id: object.id, label: object.label }, shape: polygon, distance: (p: Vec2) => pointToPolygon(p, polygon) };
    }),
    ...boundaryOf(scene).flatMap(({ segment, endedBy }) => {
      const gaps = doorways.flatMap((o, i) => (spans[i] && o.wallId === endedBy.id ? [{ span: spans[i]!, label: o.label }] : []));
      return withoutDoorways(segment, gaps.map((g) => g.span)).map((piece) => ({
        end: endedBy,
        shape: piece,
        distance: (p: Vec2) => pointToSegment(p, piece),
        frames: gaps.flatMap((g) => g.span.filter((j) => piece.some((e) => Math.hypot(e[0] - j[0], e[1] - j[1]) < 1e-6)).map((at) => ({ at, label: g.label }))),
      }));
    }),
  ];

  const { cell } = WALKWAY;
  const [x0, x1, z0, z1] = extentOf(room);
  const nx = Math.max(1, Math.round((x1 - x0) / cell));
  const nz = Math.max(1, Math.round((z1 - z0) / cell));
  const sx = (x1 - x0) / nx;
  const sz = (z1 - z0) / nz;
  const at = (c: number): Vec2 => [x0 + ((c % nx) + 0.5) * sx, z0 + (Math.floor(c / nx) + 0.5) * sz];
  const inside = new Uint8Array(nx * nz);
  const near = new Float64Array(nx * nz);
  const nearest = new Int32Array(nx * nz).fill(-1);
  const second = new Float64Array(nx * nz);
  const threshold = new Int16Array(nx * nz).fill(-1);
  for (let c = 0; c < nx * nz; c++) {
    const p = at(c);
    if (!contains(room, p)) continue;
    inside[c] = 1;
    let a = Infinity;
    let b = Infinity;
    let ia = -1;
    for (let t = 0; t < things.length; t++) {
      const d = things[t].distance(p);
      if (d < a) {
        b = a;
        a = d;
        ia = t;
      } else if (d < b) b = d;
    }
    near[c] = a;
    nearest[c] = ia;
    second[c] = b;
    // A doorway's threshold: the first row of floor inside the gap in its wall.
    threshold[c] = spans.findIndex((s) => s !== null && pointToSegment(p, s) <= cell);
  }
  return { nx, at, things, inside, near, nearest, second, threshold, doorways };
}

/** An opening's span on the floor line of its wall. */
function spanOf(scene: Scene, opening: Opening): Segment | null {
  const wall = walls(scene).find((w) => w.id === opening.wallId);
  if (!wall) return null;
  const { direction } = wallFrame(scene, wall);
  const at = (t: number): Vec2 => [wall.start[0] + direction[0] * t, wall.start[1] + direction[1] * t];
  return [at(opening.offset - opening.width / 2), at(opening.offset + opening.width / 2)];
}

/** A wall's floor line with its doorways taken out: a person passes through a doorway, not through the wall. */
function withoutDoorways([a, b]: Segment, spans: readonly Segment[]): Segment[] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!spans.length || length === 0) return [[a, b]];
  const t = (p: Vec2) => ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length;
  const gaps = spans.map(([p, q]) => [Math.min(t(p), t(q)), Math.max(t(p), t(q))] as const).sort((x, y) => x[0] - y[0]);
  const point = (s: number): Vec2 => [a[0] + ((b[0] - a[0]) * s) / length, a[1] + ((b[1] - a[1]) * s) / length];
  const pieces: Segment[] = [];
  let from = 0;
  for (const [g0, g1] of gaps) {
    if (g0 > from) pieces.push([point(from), point(Math.min(g0, length))]);
    from = Math.max(from, g1);
  }
  if (from < length) pieces.push([point(from), b]);
  return pieces;
}

export function walkwayTo(k: Knowledge, targetId: Id): Walkway {
  const target = obstaclesOf(k.scene).find((o) => o.object.id === targetId);
  if (!target) return { reachable: false, to: targetId, reason: "only pieces standing on the floor are walked to" };
  const field = fieldOf(k.scene);
  if (typeof field === "string") return { reachable: false, to: targetId, reason: field };
  const { nx, at, things, inside, near, nearest, second, threshold, doorways } = field;
  const n = inside.length;
  const own = things.findIndex((t) => t.end.kind === "object" && t.end.id === targetId);
  const targetPolygon: Polygon = polygonOf(target.footprint);

  // How clear each cell is with the piece walked to taken away; the piece itself is not floor.
  const clear = new Float64Array(n);
  const goal = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (!inside[c]) continue;
    const toTarget = pointToPolygon(at(c), targetPolygon);
    if (toTarget === 0) continue;
    clear[c] = nearest[c] === own ? second[c] : near[c];
    if (toTarget <= WALKWAY.reach) goal[c] = 1;
  }

  // Widest route: open cells widest first; the cell that first joins a doorway to the piece is the narrowest point.
  const order = [...clear.keys()].filter((c) => clear[c] > 0).sort((a, b) => clear[b] - clear[a] || a - b);
  const parent = new Int32Array(n).fill(-1);
  const door = new Int16Array(n).fill(-1);
  const reached = new Uint8Array(n);
  const root = (c: number): number => {
    while (parent[c] !== c) {
      parent[c] = parent[parent[c]];
      c = parent[c];
    }
    return c;
  };
  const join = (a: number, b: number) => {
    const ra = root(a);
    const rb = root(b);
    if (ra === rb) return;
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent[drop] = keep;
    if (door[keep] < 0 || (door[drop] >= 0 && door[drop] < door[keep])) door[keep] = door[drop];
    reached[keep] |= reached[drop];
  };
  let narrowest = -1;
  let from = -1;
  for (const c of order) {
    parent[c] = c;
    door[c] = threshold[c];
    reached[c] = goal[c];
    const i = c % nx;
    for (const m of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, c - nx, c + nx]) if (m >= 0 && m < n && parent[m] >= 0) join(c, m);
    const r = root(c);
    if (door[r] >= 0 && reached[r]) {
      narrowest = c;
      from = door[r];
      break;
    }
  }
  if (narrowest < 0) return { reachable: false, to: targetId, reason: "no route from a doorway reaches it: the pieces close it off" };

  const point = at(narrowest);
  const d = clear[narrowest];
  const around = things
    .filter((t, i) => i !== own)
    .map((t) => ({ thing: t, gap: t.distance(point) }))
    .sort((a, b) => a.gap - b.gap || a.thing.end.label.localeCompare(b.thing.end.label));
  // What bounds it: the nearest thing, and the one across from it when the route passes between two.
  const first = around[0];
  const across = around.find((t) => t !== first && t.gap <= first.gap + 1.5 * WALKWAY.cell);
  // Between two things, the way is as wide as the gap between them, which the grid only samples: take
  // the exact gap when it agrees with the grid's reading, and the grid's reading, a step coarser, when not.
  const gap = across ? convexDistance(first.thing.shape, across.thing.shape) : Infinity;
  const exact = gap >= 2 * d - 1e-9 && gap <= 2 * d + 2 * Math.SQRT2 * WALKWAY.cell;
  // A stretch of wall passed at its doorway end is the doorway's frame.
  const named = ({ thing, gap }: { thing: Thing; gap: number }): EndedBy => {
    const frame = thing.frames?.find((f) => Math.hypot(point[0] - f.at[0], point[1] - f.at[1]) <= gap + 1e-6);
    return frame ? { ...thing.end, label: `${frame.label} frame` } : thing.end;
  };
  const key = (e: EndedBy) => `${e.kind}:${e.id ?? ""}:${e.label}`;
  const ends = across ? [named(first), named(across)] : [named(first)];
  const between = ends.length === 2 && key(ends[0]) === key(ends[1]) ? [ends[0]] : ends;
  const doorway = doorways[from];
  const atDoorway = threshold[narrowest] >= 0;
  const inputs = withScale(k, [...between.flatMap((e) => endInputs(k, e)), ...(atDoorway ? [openingInput(k, doorway, "width")] : [])]);
  return {
    reachable: true,
    to: targetId,
    from: doorway.id,
    width: measurement(exact ? gap : 2 * d, "m", [targetId, doorway.id, ...between.flatMap((e) => (e.id ? [e.id] : []))], inputs, {
      resolutionFloor: exact ? WALKWAY.cell : 2 * WALKWAY.cell,
      rule: WALKWAY.version,
    }),
    at: [round(point[0]), round(point[1])],
    between,
    atDoorway,
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;
