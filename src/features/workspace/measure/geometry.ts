import type { Vec2 } from "@/scene/model/types";
import type { Footprint } from "../ai/rules/spatial";

/**
 * Exact plan geometry for measurement.
 * ================================================================
 *
 * The command layer's `Footprint` (`spatial.ts`) is the shape of a piece on
 * the floor; everything here works on it, turned into the polygon it is.
 * Unlike the layout heuristics' grid, these are exact: the distance between
 * two turned pieces corner to corner, the area of overlapping pieces counted
 * once, the clear floor in front of a seat up to what ends it.
 *
 * Frames as in `spatial.ts`: plan points are (x, z); a footprint turned by
 * `angle` has its local +X along (cos a, −sin a) and its front, local +Z,
 * along (sin a, cos a).
 */

export type Polygon = readonly Vec2[];
export type Segment = readonly [Vec2, Vec2];

/** A footprint's four corners, counter-clockwise in plan. */
export function polygonOf(f: Footprint): Polygon {
  const ax: Vec2 = [Math.cos(f.angle), -Math.sin(f.angle)];
  const az: Vec2 = [Math.sin(f.angle), Math.cos(f.angle)];
  const at = (sx: number, sz: number): Vec2 => [f.cx + ax[0] * f.hx * sx + az[0] * f.hz * sz, f.cz + ax[1] * f.hx * sx + az[1] * f.hz * sz];
  return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
}

/** Area by the shoelace formula, always positive. */
export function polygonArea(p: Polygon): number {
  let twice = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

export function perimeterOf(p: Polygon): number {
  let sum = 0;
  for (let i = 0; i < p.length; i++) sum += Math.hypot(p[(i + 1) % p.length][0] - p[i][0], p[(i + 1) % p.length][1] - p[i][1]);
  return sum;
}

/** The polygon's edges, each from a vertex to the next. */
export const edgesOf = (p: Polygon): Segment[] => p.map((a, i) => [a, p[(i + 1) % p.length]] as const);

/** Whether a polygon is usable: at least three finite points, some area. */
export const isPolygon = (p: Polygon) => p.length >= 3 && p.every((v) => Number.isFinite(v[0]) && Number.isFinite(v[1])) && polygonArea(p) > 1e-9;

/** Axis-aligned plan extent: [xMin, xMax, zMin, zMax]. */
export function extentOf(p: Polygon): [number, number, number, number] {
  const xs = p.map((v) => v[0]);
  const zs = p.map((v) => v[1]);
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
}

// ---------------------------------------------------------------------------
// Distances

export function pointToSegment(p: Vec2, [a, b]: Segment): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/**
 * Whether two convex polygons overlap or touch, by separating axes. A
 * segment (a two-point polygon) is tested along its own direction too:
 * two segments on one line are separated only along it.
 */
export function convexOverlap(a: Polygon, b: Polygon): boolean {
  for (const poly of [a, b]) {
    const edges = edgesOf(poly);
    const axes: Vec2[] = edges.map(([p, q]) => [-(q[1] - p[1]), q[0] - p[0]]);
    if (poly.length === 2) axes.push([poly[1][0] - poly[0][0], poly[1][1] - poly[0][1]]);
    for (const axis of axes) {
      const project = (s: Polygon) => s.map((v) => v[0] * axis[0] + v[1] * axis[1]);
      const pa = project(a);
      const pb = project(b);
      if (Math.max(...pa) < Math.min(...pb) - 1e-12 || Math.max(...pb) < Math.min(...pa) - 1e-12) return false;
    }
  }
  return true;
}

/**
 * The true plan distance between two convex polygons: 0 when they touch or
 * overlap, otherwise the shortest distance between their outlines. Unlike a
 * separating-axis gap, which reads only along the pieces' own edges, this is
 * the distance corner to corner too.
 */
export function convexDistance(a: Polygon, b: Polygon): number {
  if (convexOverlap(a, b)) return 0;
  let best = Infinity;
  for (const p of a) for (const e of edgesOf(b)) best = Math.min(best, pointToSegment(p, e));
  for (const p of b) for (const e of edgesOf(a)) best = Math.min(best, pointToSegment(p, e));
  return best;
}

/** Distance from a point to a polygon's outline; 0 inside it. */
export function pointToPolygon(p: Vec2, poly: Polygon): number {
  if (contains(poly, p)) return 0;
  return Math.min(...edgesOf(poly).map((e) => pointToSegment(p, e)));
}

/** Whether a point lies inside a simple polygon (even–odd rule). */
export function contains(poly: Polygon, [x, z]: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Areas

/**
 * The area of the union of `polygons` that lies inside `clip`, exactly.
 *
 * Swept across x: on any vertical line each simple polygon is a set of
 * intervals in z, and the covered length is the length of their union
 * within the clip's. Between consecutive x where some vertex lies or two
 * edges cross, every interval end moves linearly, so the covered length
 * does too, and the midpoint rule integrates each slab exactly.
 */
export function unionAreaWithin(polygons: readonly Polygon[], clip: Polygon): number {
  const all = [clip, ...polygons];
  const edges = all.flatMap(edgesOf);
  const xs = new Set<number>();
  for (const p of all) for (const v of p) xs.add(v[0]);
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const x = crossingX(edges[i], edges[j]);
      if (x !== null) xs.add(x);
    }
  }
  const [x0, x1] = extentOf(clip);
  const events = [...xs].filter((x) => x >= x0 && x <= x1).sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < events.length; i++) {
    const width = events[i + 1] - events[i];
    if (width <= 1e-12) continue;
    const x = (events[i] + events[i + 1]) / 2;
    const room = intervalsAt(clip, x);
    const covered = mergeIntervals(polygons.flatMap((p) => intervalsAt(p, x)));
    area += width * intersectionLength(room, covered);
  }
  return area;
}

/** The z intervals a vertical line at x cuts from a simple polygon. */
function intervalsAt(poly: Polygon, x: number): [number, number][] {
  const zs: number[] = [];
  for (const [a, b] of edgesOf(poly)) {
    if ((a[0] <= x && b[0] > x) || (b[0] <= x && a[0] > x)) zs.push(a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]));
  }
  zs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < zs.length; i += 2) out.push([zs[i], zs[i + 1]]);
  return out;
}

function mergeIntervals(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function intersectionLength(a: readonly [number, number][], b: readonly [number, number][]): number {
  let sum = 0;
  for (const [a0, a1] of a) for (const [b0, b1] of b) sum += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  return sum;
}

/** The x at which two segments cross, if they do. */
function crossingX([p, p2]: Segment, [q, q2]: Segment): number | null {
  const r: Vec2 = [p2[0] - p[0], p2[1] - p[1]];
  const s: Vec2 = [q2[0] - q[0], q2[1] - q[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < 1e-15) return null;
  const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denom;
  const u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? p[0] + t * r[0] : null;
}

// ---------------------------------------------------------------------------
// Clear depth in front

/**
 * A strip of floor straight out from a face: `origin` is the middle of the
 * face, `forward` a unit vector out from it, `half` half the face's width.
 */
export interface Strip {
  origin: Vec2;
  forward: Vec2;
  half: number;
}

export interface Blocker<T> {
  what: T;
  /** A polygon (a piece) or a segment (a wall), in plan. */
  shape: Polygon;
}

/**
 * How far the strip runs clear, and what ends it: the nearest point of any
 * blocker that lies over the strip, ahead of the face. Null when nothing
 * does. A blocker that already reaches the face ends it at 0.
 */
export function clearDepth<T>(strip: Strip, blockers: readonly Blocker<T>[]): { depth: number; by: T } | null {
  const { origin, forward, half } = strip;
  const across: Vec2 = [forward[1], -forward[0]];
  // Just inside the strip's edges, so a wall running along an edge does not end it.
  const h = Math.max(0, half - 1e-6);
  let best: { depth: number; by: T } | null = null;
  for (const b of blockers) {
    const local = b.shape.map((v): Vec2 => {
      const d: Vec2 = [v[0] - origin[0], v[1] - origin[1]];
      return [d[0] * across[0] + d[1] * across[1], d[0] * forward[0] + d[1] * forward[1]];
    });
    let clipped: Vec2[] = [...local];
    for (const [nx, nz, c] of [[1, 0, h], [-1, 0, h], [0, 1, 0]] as const) {
      // Keep nx·u + nz·v ≥ −c: u ≥ −h, −u ≥ −h, v ≥ 0.
      clipped = clipHalfPlane(clipped, nx, nz, c);
      if (!clipped.length) break;
    }
    if (!clipped.length) continue;
    const depth = Math.max(0, Math.min(...clipped.map((v) => v[1])));
    if (!best || depth < best.depth - 1e-12) best = { depth, by: b.what };
  }
  return best;
}

/** Sutherland–Hodgman against one half-plane nx·u + nz·v + c ≥ 0. Works for a two-point segment too. */
function clipHalfPlane(poly: readonly Vec2[], nx: number, nz: number, c: number): Vec2[] {
  const f = (v: Vec2) => nx * v[0] + nz * v[1] + c;
  const inside = (v: Vec2) => f(v) >= -1e-12;
  const cut = (a: Vec2, b: Vec2): Vec2 => {
    const t = f(a) / (f(a) - f(b));
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  };
  const n = poly.length;
  if (n === 1) return inside(poly[0]) ? [poly[0]] : [];
  if (n === 2) {
    const [a, b] = poly;
    if (inside(a) && inside(b)) return [a, b];
    if (!inside(a) && !inside(b)) return [];
    return inside(a) ? [a, cut(a, b)] : [cut(a, b), b];
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) out.push(cut(a, b));
  }
  return out;
}
