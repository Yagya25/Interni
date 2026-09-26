import { carriedBy } from "@/scene/model/operations";
import { findById, objectCenter, openingCenter, roomBounds, walls, wallFrame } from "@/scene/model/queries";
import type { Degree, MoveDirection } from "../intent";
import type { Id, ObjectCategory, Opening, Relationship, Scene, SceneObject, Surface, Vec2, Vec3, WallSurface } from "@/scene/model/types";

/**
 * Where a piece goes, worked out from the scene.
 * ================================================================
 *
 * Every destination is computed from the scene's own geometry — the pieces'
 * footprints, the walls, the openings — and the relationships the
 * reconstruction recorded. Nothing is placed at a fixed coordinate.
 *
 * Every candidate is checked before it is offered: inside the room, not
 * through another piece (footprints and heights both), and on the same wall
 * for things that hang. A move that cannot be made says what is in the way.
 *
 * Frames: +Y up, metres. A piece's local +Z is its front and local +X its
 * width; turned by `rotation[1]` about +Y, local +X is (cos a, −sin a) and
 * local +Z is (sin a, cos a) on the floor plane.
 */

/** Clearances, chosen to read as deliberate placements rather than collisions. */
export const SPACING = {
  /** Between two pieces a move brings together. */
  between: 0.3,
  /** Between a piece and the wall of an opening it moves towards. */
  fromOpeningWall: 0.3,
  /** Between pieces set side by side. */
  beside: 0.1,
  /** From a piece's front to what is set in front of it (a coffee table from a sofa). */
  inFront: 0.4,
  /** From a piece's back to what is set behind it. */
  behind: 0.15,
  /** The most a piece may stand off a wall and still be against it. */
  againstWall: 0.1,
  /** From the top of a piece to the bottom of what hangs above it. */
  above: 0.15,
  /** The step a move is marched in, and the least that counts as moving. */
  step: 0.02,
  least: 0.03,
} as const;

/** How far towards an opening or a wall a move goes, as a share of the way. */
const SHARE = { slight: 0.2, normal: 0.45, strong: 0.8 } as const;
const AWAY = { slight: 0.15, normal: 0.35, strong: 0.6 } as const;
/** How far a move in a plain direction goes when no distance is given, in metres. */
const STEP_OUT = { slight: 0.1, normal: 0.25, strong: 0.5 } as const;

/**
 * Pieces with a front of their own. Forward, in front of and behind are
 * theirs; for anything else (a table, an ottoman, a lamp) they are the
 * photograph's: in front is towards the camera.
 */
const HAS_FRONT: ReadonlySet<ObjectCategory> = new Set<ObjectCategory>([
  "sofa", "armchair", "lounge-chair", "chair", "bench", "media-console", "television", "bookshelf", "sideboard", "cabinet", "desk", "bed", "artwork", "curtain",
]);
export const hasFront = (o: SceneObject) => HAS_FRONT.has(o.category);

export type Placement =
  | { kind: "to"; to: Vec3; note: string }
  | { kind: "blocked"; message: string }
  | { kind: "already"; message: string };

export interface Footprint {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  angle: number;
  y0: number;
  y1: number;
}

export function footprintOf(o: SceneObject, at: Vec3 = o.transform.position, angle = o.transform.rotation[1], scale: Vec3 = o.transform.scale): Footprint {
  const [w, h, d] = o.dimensions;
  const [sx, sy, sz] = scale;
  return { cx: at[0], cz: at[2], hx: (w * sx) / 2, hz: (d * sz) / 2, angle, y0: at[1], y1: at[1] + h * sy };
}

const axesOf = (f: Footprint): [Vec2, Vec2] => [
  [Math.cos(f.angle), -Math.sin(f.angle)],
  [Math.sin(f.angle), Math.cos(f.angle)],
];

/** Half the footprint's extent along a unit axis on the floor. */
export function halfAlong(f: Footprint, axis: Vec2) {
  const [ax, az] = axesOf(f);
  return Math.abs(axis[0] * ax[0] + axis[1] * ax[1]) * f.hx + Math.abs(axis[0] * az[0] + axis[1] * az[1]) * f.hz;
}

/**
 * Plan-view separation of two footprints: the largest gap along any of
 * their four edge directions (separating axes). Negative when they overlap.
 */
export function separation(a: Footprint, b: Footprint) {
  const d: Vec2 = [b.cx - a.cx, b.cz - a.cz];
  let best = -Infinity;
  for (const axis of [...axesOf(a), ...axesOf(b)]) {
    const gap = Math.abs(d[0] * axis[0] + d[1] * axis[1]) - halfAlong(a, axis) - halfAlong(b, axis);
    best = Math.max(best, gap);
  }
  return best;
}

/** Whether two footprints share any height: a shelf above a table does not meet it. */
export const heightsMeet = (a: Footprint, b: Footprint) => a.y0 < b.y1 - 0.005 && b.y0 < a.y1 - 0.005;

/**
 * What a moving piece must not pass through: every other piece with some
 * height (a rug is walked over), except what it carries and what carries it.
 */
export function obstaclesFor(scene: Scene, mover: SceneObject): SceneObject[] {
  const carried = new Set(carriedBy(scene, mover.id).map((o) => o.id));
  const carrier = mover.support.kind === "object" ? mover.support.objectId : null;
  return scene.objects.filter((o) => o.id !== mover.id && !carried.has(o.id) && o.id !== carrier && o.dimensions[1] * o.transform.scale[1] > 0.05);
}

/** The first piece a footprint would pass through, if any. */
export function collision(scene: Scene, mover: SceneObject, f: Footprint, ignore: ReadonlySet<Id> = new Set()): SceneObject | null {
  for (const o of obstaclesFor(scene, mover)) {
    if (ignore.has(o.id)) continue;
    const g = footprintOf(o);
    if (heightsMeet(f, g) && separation(f, g) < -0.005) return o;
  }
  return null;
}

/** Whether the footprint stays inside the room's plan and under its ceiling. */
export function insideRoom(scene: Scene, f: Footprint) {
  const b = roomBounds(scene);
  const hx = halfAlong(f, [1, 0]);
  const hz = halfAlong(f, [0, 1]);
  const tol = 0.005;
  return f.cx - hx >= b.min[0] - tol && f.cx + hx <= b.max[0] + tol && f.cz - hz >= b.min[2] - tol && f.cz + hz <= b.max[2] + tol && f.y1 <= b.max[1] + tol;
}

/**
 * A spot held inside the room's plan, as a drag holds it: a piece that
 * isn't quite square to its wall can otherwise be set a centimetre through it.
 */
export function heldInside(scene: Scene, mover: SceneObject, at: Vec3, angle = mover.transform.rotation[1]): Vec3 {
  const b = roomBounds(scene);
  const f = footprintOf(mover, at, angle);
  const hx = halfAlong(f, [1, 0]);
  const hz = halfAlong(f, [0, 1]);
  const clampSpan = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return [round(clampSpan(at[0], b.min[0] + hx, b.max[0] - hx)), at[1], round(clampSpan(at[2], b.min[2] + hz, b.max[2] - hz))];
}

/** Why a spot is refused, in words, or null when it is free. */
export function refusal(scene: Scene, mover: SceneObject, f: Footprint, ignore?: ReadonlySet<Id>): string | null {
  if (!insideRoom(scene, f)) return "the wall";
  const hit = collision(scene, mover, f, ignore);
  return hit ? `the ${hit.label.toLowerCase()}` : null;
}

/**
 * The nearest free spot to a wanted one: the spot itself if it is free;
 * for a piece standing against a wall, the nearest free spot along that
 * wall, so it keeps its back to it; otherwise the first free point on rings
 * of growing radius (2 cm apart, up to `reach`), each ring walked from the
 * same angle. Deterministic; null when nothing within reach is free.
 */
export function settle(scene: Scene, mover: SceneObject, at: Vec3, angle: number, scale: Vec3 = mover.transform.scale, reach = 0.4): { at: Vec3; shift: number } | null {
  if (!refusal(scene, mover, footprintOf(mover, at, angle, scale))) return { at, shift: 0 };
  const wall = mover.support.kind === "floor" ? wallAgainst(scene, mover) : null;
  if (wall) {
    const { direction } = wallFrame(scene, wall);
    for (let t = SPACING.step; t <= reach + 1e-9; t += SPACING.step) {
      for (const sign of [1, -1]) {
        const p: Vec3 = [round(at[0] + direction[0] * t * sign), at[1], round(at[2] + direction[1] * t * sign)];
        if (!refusal(scene, mover, footprintOf(mover, p, angle, scale))) return { at: p, shift: t };
      }
    }
  }
  for (let r = SPACING.step; r <= reach + 1e-9; r += SPACING.step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / SPACING.step));
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      const p: Vec3 = [round(at[0] + r * Math.cos(a)), at[1], round(at[2] + r * Math.sin(a))];
      if (!refusal(scene, mover, footprintOf(mover, p, angle, scale))) return { at: p, shift: r };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Frames

/**
 * The photograph's camera, flat on the floor: `forward` is the way it looks,
 * `right` its right hand. Left, right, front and back in a command mean what
 * they mean in the photograph, the one view the person and the
 * reconstruction share; the view on screen may have been orbited anywhere.
 */
export function cameraFrame(scene: Scene): { forward: Vec2; right: Vec2 } {
  const [px, , pz] = scene.camera.position;
  const [tx, , tz] = scene.camera.target;
  const len = Math.hypot(tx - px, tz - pz) || 1;
  const forward: Vec2 = [(tx - px) / len, (tz - pz) / len];
  return { forward, right: [-forward[1], forward[0]] };
}

/** A direction on the floor, squared to the room: along whichever wall, or straight out from it, it is closest to. */
export function squared(scene: Scene, dir: Vec2): Vec2 {
  let best: Vec2 = dir;
  let bestDot = -Infinity;
  for (const w of walls(scene)) {
    const { direction, inward } = wallFrame(scene, w);
    for (const axis of [direction, inward]) {
      for (const sign of [1, -1]) {
        const a: Vec2 = [axis[0] * sign, axis[1] * sign];
        const dot = a[0] * dir[0] + a[1] * dir[1];
        if (dot > bestDot + 1e-9) {
          bestDot = dot;
          best = a;
        }
      }
    }
  }
  return best;
}

/** Where a point falls across the photograph, left (negative) to right, as a tangent. */
function acrossPhoto(scene: Scene, p: Vec3) {
  const { forward, right } = cameraFrame(scene);
  const [cx, , cz] = scene.camera.position;
  const d: Vec2 = [p[0] - cx, p[2] - cz];
  const depth = Math.max(0.05, d[0] * forward[0] + d[1] * forward[1]);
  return (d[0] * right[0] + d[1] * right[1]) / depth;
}

/** The unit direction on the floor from one point to another, and how far. */
const towards = (from: Vec3, to: Vec3): { dir: Vec2; dist: number } => {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const dist = Math.hypot(dx, dz);
  return { dir: dist > 1e-9 ? [dx / dist, dz / dist] : [0, 0], dist };
};

// ---------------------------------------------------------------------------
// What the recorded relationships still say

/**
 * Whether a relationship the reconstruction recorded still holds after the
 * room has been edited. A piece pulled off its wall is no longer against it,
 * and a lamp carried across the room is no longer beside the sofa; ones
 * that can't drift this way (faces, on, above) are taken as recorded.
 */
export function holds(scene: Scene, r: Relationship): boolean {
  const subject = findById(scene.objects, r.subjectId);
  if (!subject) return false;
  if (r.predicate === "against") {
    const wall = walls(scene).find((w) => w.id === r.objectId);
    if (!wall) return true;
    const { inward } = wallFrame(scene, wall);
    return distanceToWall(wall, subject.transform.position) - halfAlong(footprintOf(subject), inward) <= SPACING.againstWall;
  }
  if (r.predicate === "beside" || r.predicate === "in-front-of") {
    const other = findById(scene.objects, r.objectId);
    return !other || separation(footprintOf(subject), footprintOf(other)) <= 1;
  }
  return true;
}

/**
 * How near a piece is to something, in plan: the gap between footprints to
 * another piece, and to an opening or a wall, the gap from its footprint.
 */
export function gapTo(scene: Scene, object: SceneObject, to: SceneObject | Opening | WallSurface): number {
  const f = footprintOf(object);
  if ("category" in to) return separation(f, footprintOf(to));
  const wall = "wallId" in to ? walls(scene).find((w) => w.id === to.wallId) : to;
  if (!wall) return Infinity;
  const { inward } = wallFrame(scene, wall);
  const along = "wallId" in to ? openingCenter(scene, to) : null;
  const toWall = distanceToWall(wall, object.transform.position) - halfAlong(f, inward);
  if (!along) return toWall;
  // To an opening: off its wall, and off its span along the wall.
  const { direction } = wallFrame(scene, wall);
  const offAlong = Math.abs((object.transform.position[0] - along[0]) * direction[0] + (object.transform.position[2] - along[2]) * direction[1]) - (to as Opening).width / 2 - halfAlong(f, direction);
  return Math.hypot(Math.max(0, toWall), Math.max(0, offAlong));
}

// ---------------------------------------------------------------------------
// References

export type Reference =
  | { kind: "object"; object: SceneObject }
  | { kind: "opening"; opening: Opening }
  | { kind: "wall"; wall: WallSurface };

/**
 * The wall a piece hangs on, or the wall a floor piece stands against as
 * the reconstruction (or the author) recorded it — while it still does.
 */
export function wallAgainst(scene: Scene, object: SceneObject): WallSurface | null {
  if (object.support.kind === "wall") {
    const id = object.support.wallId;
    return walls(scene).find((w) => w.id === id) ?? null;
  }
  const r = scene.relationships.find((x) => x.subjectId === object.id && x.predicate === "against");
  if (!r || !holds(scene, r)) return null;
  return walls(scene).find((w) => w.id === r.objectId) ?? null;
}

/** The nearest wall to a point on the floor, for "against the wall". */
export function nearestWall(scene: Scene, point: Vec3): WallSurface | null {
  let best: WallSurface | null = null;
  let bestD = Infinity;
  for (const w of walls(scene)) {
    const d = distanceToWall(w, point);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

/** Plan distance from a point to a wall's base line. */
export function distanceToWall(w: WallSurface, p: Vec3) {
  const dx = w.end[0] - w.start[0];
  const dz = w.end[1] - w.start[1];
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - w.start[0]) * dx + (p[2] - w.start[1]) * dz) / len2));
  return Math.hypot(p[0] - (w.start[0] + dx * t), p[2] - (w.start[1] + dz * t));
}

function pointOf(scene: Scene, ref: Reference, from: Vec3): Vec3 {
  if (ref.kind === "object") return objectCenter(ref.object);
  if (ref.kind === "opening") return openingCenter(scene, ref.opening);
  const w = ref.wall;
  const dx = w.end[0] - w.start[0];
  const dz = w.end[1] - w.start[1];
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((from[0] - w.start[0]) * dx + (from[2] - w.start[1]) * dz) / len2));
  return [w.start[0] + dx * t, from[1], w.start[1] + dz * t];
}

const labelOf = (ref: Reference) => (ref.kind === "object" ? ref.object.label : ref.kind === "opening" ? ref.opening.label : ref.wall.label).toLowerCase();

// ---------------------------------------------------------------------------
// Moves

/**
 * Closer to, or away from, a reference. A piece standing against a wall
 * slides along that wall (a sofa keeps its back to the wall); a hanging
 * piece slides along its own wall. Towards a piece, it stops at a
 * comfortable clearance; towards an opening, it goes part of the way.
 * It is marched in small steps and stops at the first wall or piece.
 */
export function moveRelative(scene: Scene, mover: SceneObject, ref: Reference, away: boolean, degree: Degree, distance: number | null = null): Placement {
  const start = mover.transform.position;
  const target = pointOf(scene, ref, start);
  let dir: Vec2 = [target[0] - start[0], target[2] - start[2]];
  const dist = Math.hypot(dir[0], dir[1]);
  if (dist < 1e-6) return { kind: "already", message: `The ${mover.label.toLowerCase()} is already there.` };
  dir = [dir[0] / dist, dir[1] / dist];
  if (away) dir = [-dir[0], -dir[1]];

  const wall = wallAgainst(scene, mover);
  let alongWall = false;
  if (wall) {
    const { direction } = wallFrame(scene, wall);
    const along = dir[0] * direction[0] + dir[1] * direction[1];
    if (mover.support.kind === "wall" || Math.abs(along) >= 0.2) {
      dir = along >= 0 ? direction : [-direction[0], -direction[1]];
      alongWall = true;
      if (Math.abs(along) < 0.2) {
        return { kind: "blocked", message: `The ${mover.label.toLowerCase()} hangs on the ${wall.label.toLowerCase()}, and the ${labelOf(ref)} is straight out from it: it can’t get closer along its wall.` };
      }
    }
  }

  const refFootprint = ref.kind === "object" ? footprintOf(ref.object) : null;
  const budget =
    refFootprint && !away
      ? Math.max(0, separation(footprintOf(mover), refFootprint) - SPACING.between)
      : (away ? AWAY[degree] : SHARE[degree]) * dist;
  const cap = distance !== null ? Math.min(budget, distance) : ref.kind === "object" && !away && degree === "slight" ? Math.min(budget, 0.25) : budget;
  const openingWall = ref.kind === "opening" ? walls(scene).find((w) => w.id === ref.opening.wallId) : null;

  let travelled = 0;
  let stoppedBy: string | null = null;
  for (let t = SPACING.step; t <= cap + 1e-9; t += SPACING.step) {
    const at: Vec3 = [start[0] + dir[0] * t, start[1], start[2] + dir[1] * t];
    const f = footprintOf(mover, at);
    const why = refusal(scene, mover, f, ref.kind === "object" ? new Set([ref.object.id]) : undefined);
    if (why) {
      stoppedBy = why;
      break;
    }
    if (refFootprint && !away && separation(f, refFootprint) < SPACING.between) break;
    if (openingWall && mover.support.kind !== "wall" && !alongWall && distanceToWall(openingWall, at) - halfAlong(f, wallFrame(scene, openingWall).inward) < SPACING.fromOpeningWall) {
      break;
    }
    travelled = t;
  }
  if (travelled < SPACING.least) {
    if (stoppedBy) return { kind: "blocked", message: `The ${mover.label.toLowerCase()} can’t move ${away ? "further from" : "closer to"} the ${labelOf(ref)}: ${stoppedBy} is in the way.` };
    const gap = refFootprint && !away ? separation(footprintOf(mover), refFootprint) : null;
    return {
      kind: "already",
      message:
        gap !== null
          ? gap < SPACING.between - 0.005
            ? `The ${mover.label.toLowerCase()} is already only ${cm(Math.max(0, gap))} from the ${labelOf(ref)}, closer than the ${cm(SPACING.between)} left between pieces for comfort.`
            : `The ${mover.label.toLowerCase()} is already ${cm(gap)} from the ${labelOf(ref)}, about as close as it comfortably goes (${cm(SPACING.between)}).`
          : `The ${mover.label.toLowerCase()} is already as ${away ? "far from" : "close to"} the ${labelOf(ref)} as it comfortably goes.`,
    };
  }
  const to: Vec3 = [round(start[0] + dir[0] * travelled), start[1], round(start[2] + dir[1] * travelled)];
  const how = alongWall ? ` along the ${(wall as WallSurface).label.toLowerCase()}` : "";
  const short = distance !== null && travelled < distance - SPACING.step / 2;
  const note = `moved ${cm(travelled)}${short ? ` of the ${cm(distance)} asked` : ""}${how}${stoppedBy ? `, stopping at ${stoppedBy}` : short && refFootprint && !away ? `, ${cm(SPACING.between)} from it` : ""}`;
  return { kind: "to", to, note };
}

/**
 * In a plain direction: left and right as the photograph shows the room,
 * squared to its walls; forward and backward the way the piece faces, or
 * for a piece with no front, towards and away from the camera; up and down
 * for what hangs on a wall. Marched in small steps, stopping at the first
 * wall or piece; a stated distance is kept to, or said to be cut short.
 */
export function directional(scene: Scene, mover: SceneObject, direction: MoveDirection, distance: number | null, degree: Degree): Placement {
  const name = mover.label.toLowerCase();
  const want = distance ?? STEP_OUT[degree];
  const start = mover.transform.position;
  const hung = mover.support.kind === "wall";
  let step: Vec3;
  let frame: string;
  if (direction === "up" || direction === "down") {
    if (!hung) return { kind: "blocked", message: `The ${name} stands on the floor; only what hangs on a wall moves up or down.` };
    step = [0, direction === "up" ? 1 : -1, 0];
    frame = "";
  } else if (hung) {
    if (direction === "forward" || direction === "backward") return { kind: "blocked", message: `The ${name} hangs on a wall; it can move left, right, up or down along it.` };
    const wall = wallAgainst(scene, mover);
    if (!wall) return { kind: "blocked", message: `The ${name} isn’t on a wall this room has.` };
    const { direction: along } = wallFrame(scene, wall);
    // Along its wall, whichever way moves it the asked way across the photograph.
    const probe: Vec3 = [start[0] + along[0] * 0.1, start[1], start[2] + along[1] * 0.1];
    const rightward = acrossPhoto(scene, probe) > acrossPhoto(scene, start);
    const sign = (direction === "right") === rightward ? 1 : -1;
    step = [along[0] * sign, 0, along[1] * sign];
    frame = ` along the ${wall.label.toLowerCase()}`;
  } else if (direction === "left" || direction === "right") {
    const { right } = cameraFrame(scene);
    const d = squared(scene, direction === "right" ? right : [-right[0], -right[1]]);
    step = [d[0], 0, d[1]];
    frame = " (as the photo shows the room)";
  } else if (hasFront(mover)) {
    const a = mover.transform.rotation[1];
    const s = direction === "forward" ? 1 : -1;
    step = [Math.sin(a) * s, 0, Math.cos(a) * s];
    frame = direction === "forward" ? " (the way it faces)" : " (away from the way it faces)";
  } else {
    const { forward } = cameraFrame(scene);
    const d = squared(scene, direction === "forward" ? [-forward[0], -forward[1]] : forward);
    step = [d[0], 0, d[1]];
    frame = direction === "forward" ? " (towards the photo’s viewpoint)" : " (away from the photo’s viewpoint)";
  }

  const bounds = roomBounds(scene);
  const height = mover.dimensions[1] * mover.transform.scale[1];
  let travelled = 0;
  let stoppedBy: string | null = null;
  for (let t = SPACING.step; t <= want + 1e-9; t += SPACING.step) {
    const at: Vec3 = [start[0] + step[0] * t, start[1] + step[1] * t, start[2] + step[2] * t];
    if (at[1] < -1e-9 || at[1] + height > bounds.max[1] + 1e-9) {
      stoppedBy = at[1] < 0 ? "the floor" : "the ceiling";
      break;
    }
    const why = refusal(scene, mover, footprintOf(mover, at));
    if (why) {
      stoppedBy = why;
      break;
    }
    travelled = t;
  }
  const said = direction === "backward" ? "back" : direction;
  if (travelled < SPACING.least) {
    return { kind: "blocked", message: `The ${name} can’t move ${said}${frame}: ${stoppedBy ?? "there’s no room"} is in the way.` };
  }
  const to: Vec3 = [round(start[0] + step[0] * travelled), round(start[1] + step[1] * travelled), round(start[2] + step[2] * travelled)];
  const short = travelled < want - SPACING.step / 2;
  const note = `moved ${cm(travelled)}${distance !== null && short ? ` of the ${cm(distance)} asked` : ""} ${said}${frame}${stoppedBy && short ? `, stopping at ${stoppedBy}` : ""}`;
  return { kind: "to", to, note };
}

/**
 * Beside a piece: on whichever side of it is nearer and free, a small gap
 * away. When the piece stands against a wall, the mover lines up with the
 * same wall (a lamp beside a sofa stands back by the wall too).
 */
export function beside(scene: Scene, mover: SceneObject, ref: SceneObject): Placement {
  const r = footprintOf(ref);
  const m = footprintOf(mover);
  const [sideAxis, front] = axesOf(r);
  if (mover.support.kind === "wall" || ref.support.kind === "wall") {
    const mw = wallAgainst(scene, mover);
    const rw = wallAgainst(scene, ref);
    if (!mw || !rw || mw.id !== rw.id) {
      return { kind: "blocked", message: `The ${mover.label.toLowerCase()} and the ${ref.label.toLowerCase()} aren’t on the same wall, and moving a piece between walls isn’t supported yet.` };
    }
  }
  // A piece already standing off one end of the reference, within the spacing, is beside it:
  // carrying it round to the other end because its own end has no 10 cm spare would be a trip
  // across the room nobody asked for.
  const offset: Vec2 = [m.cx - r.cx, m.cz - r.cz];
  const gap = Math.abs(offset[0] * sideAxis[0] + offset[1] * sideAxis[1]) - r.hx - halfAlong(m, sideAxis);
  const inLine = Math.abs(offset[0] * front[0] + offset[1] * front[1]) <= r.hz + halfAlong(m, front);
  if (inLine && gap > -SPACING.least && gap <= SPACING.beside + SPACING.least) {
    return { kind: "already", message: `The ${mover.label.toLowerCase()} is already beside the ${ref.label.toLowerCase()}${gap < 0.01 ? ", against its end" : `, ${cm(gap)} from it`}.` };
  }
  const wall = wallAgainst(scene, ref);
  const backAligned = wall !== null && mover.support.kind !== "wall";
  const candidates = [1, -1].map((sign) => {
    const along = sign * (r.hx + halfAlong(m, sideAxis) + SPACING.beside);
    let x = r.cx + sideAxis[0] * along;
    let z = r.cz + sideAxis[1] * along;
    if (backAligned) {
      // Put the mover's back on the reference's back line.
      const shift = halfAlong(m, front) - r.hz;
      x += front[0] * shift;
      z += front[1] * shift;
    }
    return heldInside(scene, mover, [round(x), mover.transform.position[1], round(z)]);
  });
  const from = mover.transform.position;
  candidates.sort((a, b) => Math.hypot(a[0] - from[0], a[2] - from[2]) - Math.hypot(b[0] - from[0], b[2] - from[2]));
  const reasons: string[] = [];
  for (const to of candidates) {
    const why = refusal(scene, mover, footprintOf(mover, to));
    if (why) {
      reasons.push(why);
      continue;
    }
    const moved = Math.hypot(to[0] - from[0], to[2] - from[2]);
    if (moved < SPACING.least) return { kind: "already", message: `The ${mover.label.toLowerCase()} is already beside the ${ref.label.toLowerCase()}.` };
    return { kind: "to", to, note: `set beside the ${ref.label.toLowerCase()}, ${cm(SPACING.beside)} from it (moved ${cm(moved)})` };
  }
  return { kind: "blocked", message: `There’s no free space beside the ${ref.label.toLowerCase()}: ${[...new Set(reasons)].join(" and ")} ${reasons.length > 1 ? "are" : "is"} in the way on either side.` };
}

/**
 * Above a piece: for things that hang, on the same wall, centred over it
 * and a hand's width above its top.
 */
export function above(scene: Scene, mover: SceneObject, ref: SceneObject): Placement {
  if (mover.support.kind !== "wall") {
    return { kind: "blocked", message: `Only something that hangs on a wall can go above another piece; the ${mover.label.toLowerCase()} stands on the floor. Putting a piece on top of another isn’t supported yet.` };
  }
  const wall = walls(scene).find((w) => w.id === (mover.support as { wallId: Id }).wallId);
  const refWall = wallAgainst(scene, ref) ?? nearestWallWithin(scene, ref, 0.4);
  if (!wall || !refWall || refWall.id !== wall.id) {
    return { kind: "blocked", message: `The ${mover.label.toLowerCase()} hangs on the ${wall?.label.toLowerCase() ?? "wall"}, but the ${ref.label.toLowerCase()} isn’t against that wall. Moving a piece to another wall isn’t supported yet.` };
  }
  const { direction } = wallFrame(scene, wall);
  const [mx, my, mz] = mover.transform.position;
  const refCentre = objectCenter(ref);
  const shift = (refCentre[0] - mx) * direction[0] + (refCentre[2] - mz) * direction[1];
  const bottom = ref.transform.position[1] + ref.dimensions[1] * ref.transform.scale[1] + SPACING.above;
  const height = mover.dimensions[1] * mover.transform.scale[1];
  if (bottom + height > scene.room.height - 0.02) {
    return { kind: "blocked", message: `There isn’t room for the ${mover.label.toLowerCase()} above the ${ref.label.toLowerCase()}: it would reach past the ceiling.` };
  }
  const to: Vec3 = [round(mx + direction[0] * shift), round(bottom), round(mz + direction[1] * shift)];
  const why = refusal(scene, mover, footprintOf(mover, to));
  if (why) return { kind: "blocked", message: `The ${mover.label.toLowerCase()} can’t go above the ${ref.label.toLowerCase()}: ${why} is in the way.` };
  const moved = Math.hypot(to[0] - mx, to[1] - my, to[2] - mz);
  if (moved < SPACING.least) return { kind: "already", message: `The ${mover.label.toLowerCase()} is already above the ${ref.label.toLowerCase()}.` };
  return { kind: "to", to, note: `centred above the ${ref.label.toLowerCase()}, ${cm(SPACING.above)} over its top (moved ${cm(moved)})` };
}

/**
 * In front of a piece, or behind it: along its own front for a piece that
 * has one, at a comfortable distance; for one that doesn't (a table), on
 * the side towards the photograph's camera, or away from it.
 */
export function inFrontOf(scene: Scene, mover: SceneObject, ref: SceneObject, behindIt = false): Placement {
  const where = behindIt ? "behind" : "in front of";
  const name = mover.label.toLowerCase();
  const refName = ref.label.toLowerCase();
  if (mover.support.kind === "wall") return { kind: "blocked", message: `The ${name} hangs on a wall; it can’t stand ${where} the ${refName}.` };
  const r = footprintOf(ref);
  const own = hasFront(ref);
  const { forward } = cameraFrame(scene);
  const facing: Vec2 = own ? axesOf(r)[1] : squared(scene, [-forward[0], -forward[1]]);
  const front: Vec2 = behindIt ? [-facing[0], -facing[1]] : facing;
  const m = footprintOf(mover);
  const gap = behindIt ? SPACING.behind : SPACING.inFront;
  const reach = halfAlong(r, front) + gap + halfAlong(m, front);
  const to = heldInside(scene, mover, [round(r.cx + front[0] * reach), mover.transform.position[1], round(r.cz + front[1] * reach)]);
  const why = refusal(scene, mover, footprintOf(mover, to));
  const side = own ? "" : behindIt ? " (away from the photo’s viewpoint)" : " (on the photo’s side of it)";
  if (why) return { kind: "blocked", message: `The ${name} can’t go ${where} the ${refName}${side}: ${why} is in the way.` };
  const from = mover.transform.position;
  const moved = Math.hypot(to[0] - from[0], to[2] - from[2]);
  if (moved < SPACING.least) return { kind: "already", message: `The ${name} is already ${where} the ${refName}.` };
  return { kind: "to", to, note: `set ${cm(gap)} ${where} the ${refName}${side} (moved ${cm(moved)})` };
}

/** The turn about +Y that points a piece's front (local +Z) at a point. */
export function facingAngle(object: SceneObject, point: Vec3): number | null {
  const { dir, dist } = towards(object.transform.position, point);
  return dist < 1e-6 ? null : Math.atan2(dir[0], dir[1]);
}

/** Back against a wall: the nearest one, or the one named. */
export function againstWall(scene: Scene, mover: SceneObject, wall: WallSurface | null): Placement {
  if (mover.support.kind === "wall") return { kind: "already", message: `The ${mover.label.toLowerCase()} already hangs on a wall.` };
  const w = wall ?? nearestWall(scene, mover.transform.position);
  if (!w) return { kind: "blocked", message: "This room has no wall to move it against." };
  const { inward } = wallFrame(scene, w);
  const f = footprintOf(mover);
  const from = mover.transform.position;
  const gap = distanceToWall(w, from) - halfAlong(f, inward) - 0.01;
  if (gap < SPACING.least) return { kind: "already", message: `The ${mover.label.toLowerCase()} is already against the ${w.label.toLowerCase()}.` };
  const to = heldInside(scene, mover, [round(from[0] - inward[0] * gap), from[1], round(from[2] - inward[1] * gap)]);
  const why = refusal(scene, mover, footprintOf(mover, to));
  if (why) return { kind: "blocked", message: `The ${mover.label.toLowerCase()} can’t go against the ${w.label.toLowerCase()}: ${why} is in the way.` };
  return { kind: "to", to, note: `moved ${cm(gap)} back against the ${w.label.toLowerCase()}` };
}

function nearestWallWithin(scene: Scene, object: SceneObject, limit: number) {
  const f = footprintOf(object);
  const w = nearestWall(scene, object.transform.position);
  if (!w) return null;
  const { inward } = wallFrame(scene, w);
  return distanceToWall(w, object.transform.position) - halfAlong(f, inward) <= limit ? w : null;
}

// ---------------------------------------------------------------------------

export function wallOfSurface(scene: Scene, surface: Surface) {
  return surface.kind === "wall" ? (findById(walls(scene), surface.id) ?? null) : null;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const cm = (metres: number) => `${Math.round(metres * 100)} cm`;
