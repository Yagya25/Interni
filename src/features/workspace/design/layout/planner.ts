import { facedBy, isAbove, isBeside, isInFrontOf, type RelationInput } from "@/scene/compile/relationships";
import { applyOperations, moveWithLoad, type SceneOperation } from "@/scene/model/operations";
import { findById, roomBounds, roomCentroid, walls, wallFrame } from "@/scene/model/queries";
import type { Id, Relationship, Scene, SceneObject, Vec2, Vec3 } from "@/scene/model/types";
import { footprintOf, halfAlong, hasFront, heightsMeet, insideRoom, obstaclesFor, separation } from "../../ai/rules/spatial";
import type { LayoutAnalysis } from "./analysis";
import { circulationOf, type Circulation } from "./circulation";
import { atPose, frontOf, frontZone, intrusion, nearestWallOf, PASSAGE, passageZones, poseOf, relationsOf, round, squaredAngles, turnBetween, wallBehind, type Pose } from "./geometry";
import type { LayoutAxis } from "./intent";
import { goalFor, type Goal, type LayoutContext, type LayoutReading } from "./strategies";
import { validateLayout } from "./validate";

/**
 * The layout planner.
 * ================================================================
 *
 *   Scene + LayoutAnalysis + reading → move operations, or a reason
 *
 * Greedy and deterministic. Pieces are placed one at a time in the order the
 * direction gives (the main seat, its table, the other seats, then lamps
 * and the rest). For each, every free spot on a 10 cm grid, every spot
 * against a wall, and every heading worth trying is checked against the
 * hard constraints — inside the room, clear of every other piece with room
 * to sit, no further into a doorway than it already stood — and the
 * survivors are weighed by the direction's preferences and the general
 * ones (don't move far, don't turn far, keep a piece's wall and its
 * relationships). A piece moves only when the best spot is clearly better
 * than where it already is: a layout changes what it needs to, not
 * everything it can.
 *
 * The result is ordinary `move` operations — built by `moveWithLoad`, the
 * same helper a drag uses, so a table takes its vase along — checked again
 * by the layout validator before anything is offered.
 */

export const PLANNER = {
  version: "layout-planner-0.1",
  /** Grid spacing for candidate positions, metres. */
  step: 0.1,
  /** Spacing of candidate positions along a wall. */
  wallStep: 0.05,
  /** How far off a wall a piece set against it stands. */
  wallGap: 0.02,
  /** Room in front of a seat for legs. */
  legroom: 0.3,
  /** A move has to be at least this much better than staying put. */
  minGain: 0.12,
  /** A layout may not shrink the walkable floor below this share of what it was. */
  keepWalkable: 0.7,
  /** An open layout has to free at least this much walkable floor, m². */
  openGain: 0.2,
  /** How many of a piece's best poses are checked for walkability before it stays put. */
  walkChecks: 24,
  /** Poses this near one that failed that check are not tried again. */
  walkSpread: 0.3,
} as const;

/** What the general preferences cost, per unit. Internal weights, never shown. */
const PREFER = { turn: 0.1, square: 0.2, wall: 0.8, edge: 0.8, balance: 0.3, beside: 0.25, inFront: 0.4, faces: 0.3, above: 0.25 } as const;

export interface LayoutPlan {
  operations: readonly SceneOperation[];
  /** Pieces the plan moves or turns, in the order they were placed. */
  moved: readonly Id[];
  /** Each moved piece's operations: its own move, then what it carries. */
  steps: readonly { id: Id; operations: readonly SceneOperation[] }[];
  before: Scene;
  after: Scene;
  relationships: { before: readonly Relationship[]; after: readonly Relationship[] };
  circulation: { before: Circulation; after: Circulation };
}

export type PlanResult = { ok: true; plan: LayoutPlan } | { ok: false; reason: string };

export function contextOf(scene: Scene, layout: LayoutAnalysis, axes: Readonly<Record<LayoutAxis, number>>): LayoutContext {
  const find = (id: Id | null) => (id ? (findById(scene.objects, id) ?? null) : null);
  return {
    scene,
    roles: new Map(layout.roles.map((r) => [r.id, r])),
    primary: find(layout.seating.primary),
    table: find(layout.focal.table),
    display: find(layout.focal.display),
    zones: passageZones(scene),
    squared: squaredAngles(scene),
    circulation: layout.circulation,
    axes,
    gap: round(0.05 + 0.25 * Math.max(0, axes.separation), 0.001),
  };
}

export function planLayout(ctx: LayoutContext, reading: LayoutReading): PlanResult {
  const before = ctx.circulation;
  const goal = goalFor(ctx, reading);
  const relationsBefore = relationsOf(ctx.scene);
  let working = ctx.scene;
  const placed: Id[] = [];

  for (const [index, id] of goal.order.entries()) {
    const piece = findById(working.objects, id)!;
    const later = new Set(goal.order.slice(index + 1));
    const chosen = choose(ctx, goal, piece, working, later, relationsBefore);
    if (!chosen) return { ok: false, reason: `there is no free spot left for the ${piece.label.toLowerCase()}` };
    placed.push(id);
    if (samePose(chosen, poseOf(piece))) continue;
    working = applyOperations(working, moveWithLoad(working, piece, chosen.at, chosen.rotationY));
  }

  // One move per piece, from the room as it was: applying these to the room gives exactly `working`.
  const moved = placed.filter((id) => !samePose(poseOf(findById(working.objects, id)!), poseOf(findById(ctx.scene.objects, id)!)));
  if (moved.length === 0) return { ok: false, reason: "the room already reads that way: nothing would need to move" };
  const steps = moved.map((id) => {
    const to = poseOf(findById(working.objects, id)!);
    return { id, operations: moveWithLoad(ctx.scene, findById(ctx.scene.objects, id)!, to.at, to.rotationY) };
  });
  const operations = steps.flatMap((step) => step.operations);
  const after = applyOperations(ctx.scene, operations);

  const checked = validateLayout(ctx.scene, after, operations);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const circulation = circulationOf(after);
  if (circulation.walkableArea < PLANNER.keepWalkable * before.walkableArea) {
    return { ok: false, reason: `it would close the walkable floor in from ${before.walkableArea.toFixed(1)} m² to ${circulation.walkableArea.toFixed(1)} m²` };
  }
  if (reading.style === "OPEN") {
    // A clear way in is judged by the way in; an open floor, by the floor.
    const blocked = (c: Circulation) => c.passages.reduce((n, p) => n + p.blockedBy.length, 0);
    const done = reading.params.entranceOnly ? blocked(circulation) < blocked(before) : circulation.walkableArea >= before.walkableArea + PLANNER.openGain;
    if (!done) return { ok: false, reason: reading.params.entranceOnly ? "nothing movable can be taken out of the way in" : "the room is already about as open as its furniture allows" };
  }
  return {
    ok: true,
    plan: { operations, moved, steps, before: ctx.scene, after, relationships: { before: relationsBefore, after: relationsOf(after) }, circulation: { before, after: circulation } },
  };
}

// ---------------------------------------------------------------------------
// One piece

/**
 * The pose a piece takes: the best free one, or where it already stands
 * when nothing is clearly better. Null when it cannot stay and has nowhere
 * to go.
 */
function choose(ctx: LayoutContext, goal: Goal, piece: SceneObject, working: Scene, later: ReadonlySet<Id>, relations: readonly Relationship[]): Pose | null {
  const original = findById(ctx.scene.objects, piece.id)!;
  const home = poseOf(original);
  const current = poseOf(piece);
  const obstacles = obstaclesFor(working, piece)
    .filter((o) => !later.has(o.id))
    .map((o) => ({ o, f: footprintOf(o), moved: !samePose(poseOf(o), poseOf(findById(ctx.scene.objects, o.id)!)) }));
  const already = ctx.zones.map(({ zone }) => intrusion(footprintOf(original), zone));
  const seat = hasFront(piece) && ctx.roles.get(piece.id)?.role.endsWith("SEATING");
  const prefer = preferences(ctx, goal, piece, home, working, relations);

  const fits = (pose: Pose): boolean => {
    const f = footprintOf(piece, pose.at, pose.rotationY);
    if (!insideRoom(working, f)) return false;
    for (const { f: g } of obstacles) if (heightsMeet(f, g) && separation(f, g) < ctx.gap) return false;
    for (const [i, { zone }] of ctx.zones.entries()) if (intrusion(f, zone) > Math.max(PASSAGE.tolerance, already[i]) + 1e-6) return false;
    if (seat) {
      const legs = frontZone(f, PLANNER.legroom);
      if (!insideRoom(working, legs)) return false;
      for (const { f: g } of obstacles) if (separation(legs, g) < 0) return false;
    }
    return true;
  };
  // Where it stands may be kept as the photograph had it, near pieces the plan has not touched.
  const stays = (pose: Pose): boolean => {
    const f = footprintOf(piece, pose.at, pose.rotationY);
    return obstacles.every(({ f: g, moved }) => !moved || !heightsMeet(f, g) || separation(f, g) >= ctx.gap - 1e-6);
  };
  const cheap = (pose: Pose) => goal.cost(piece, pose, working) + prefer.cheap(pose);
  const keep = stays(current) ? cheap(current) + prefer.related(current) : Infinity;

  // Every free pose clearly better than staying put, cheapest first. The
  // relationship term is only ever added, so a pose already too dear
  // without it is passed over without working it out.
  const bar = keep - PLANNER.minGain;
  const better: { pose: Pose; cost: number; order: number }[] = [];
  let order = 0;
  for (const pose of candidates(ctx, goal, piece, working)) {
    order++;
    const base = cheap(pose);
    if (base >= bar || !fits(pose)) continue;
    const cost = base + prefer.related(pose);
    if (cost < bar) better.push({ pose, cost, order });
  }
  better.sort((a, b) => a.cost - b.cost || a.order - b.order);

  // The best of them that still lets a person reach every seat and every way in they could reach
  // before. A spot that shuts something in rules out its near neighbours too, so the checks go to
  // genuinely different places rather than to the same spot turned a little.
  const failed: Vec3[] = [];
  let checks = 0;
  for (const { pose } of better) {
    if (checks === PLANNER.walkChecks) break;
    if (failed.some((f) => Math.hypot(f[0] - pose.at[0], f[2] - pose.at[2]) < PLANNER.walkSpread)) continue;
    checks++;
    if (stillWalkable(ctx, working, piece, pose)) return pose;
    failed.push(pose.at);
  }
  return keep < Infinity ? current : null;
}

/** Whether the room, with this piece at this pose, can still be walked as it could before the layout. */
function stillWalkable(ctx: LayoutContext, working: Scene, piece: SceneObject, pose: Pose): boolean {
  const after = circulationOf(applyOperations(working, moveWithLoad(working, piece, pose.at, pose.rotationY)));
  const before = ctx.circulation;
  return (
    after.seats.every((s) => s.reachable || !before.seats.find((b) => b.id === s.id)?.reachable) &&
    after.passages.every((p) => p.reachable || !before.passages.find((b) => b.openingId === p.openingId)?.reachable)
  );
}

/** Every pose worth trying, in a fixed order: the grid, then against each wall. */
function* candidates(ctx: LayoutContext, goal: Goal, piece: SceneObject, working: Scene): Generator<Pose> {
  const b = roomBounds(working);
  const y = piece.transform.position[1];
  const own = round(piece.transform.rotation[1], 0.0001);
  // Turned where it stands.
  const here: Vec2 = [piece.transform.position[0], piece.transform.position[2]];
  for (const heading of headingsAt(ctx, goal, piece, here, working, own)) yield { at: piece.transform.position, rotationY: heading };
  const nx = Math.floor((b.max[0] - b.min[0]) / PLANNER.step);
  const nz = Math.floor((b.max[2] - b.min[2]) / PLANNER.step);
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const at: Vec2 = [round(b.min[0] + (i + 0.5) * PLANNER.step, 0.001), round(b.min[2] + (k + 0.5) * PLANNER.step, 0.001)];
      for (const heading of headingsAt(ctx, goal, piece, at, working, own)) yield { at: [at[0], y, at[1]], rotationY: heading };
    }
  }
  for (const wall of walls(working)) {
    const { direction, inward, length } = wallFrame(working, wall);
    const headings = hasFront(piece) ? [round(Math.atan2(inward[0], inward[1]), 0.0001)] : [own, ...ctx.squared];
    for (const heading of headings) {
      const f = footprintOf(piece, [0, y, 0], heading);
      const off = halfAlong(f, inward) + PLANNER.wallGap;
      const span = halfAlong(f, direction);
      for (let t = span; t <= length - span + 1e-9; t += PLANNER.wallStep) {
        yield { at: [round(wall.start[0] + direction[0] * t + inward[0] * off, 0.001), y, round(wall.start[1] + direction[1] * t + inward[1] * off, 0.001)], rotationY: heading };
      }
    }
  }
}

function headingsAt(ctx: LayoutContext, goal: Goal, piece: SceneObject, at: Vec2, working: Scene, own: number): number[] {
  const out: number[] = [];
  for (const h of [own, ...ctx.squared, ...goal.headings(piece, at, working).map((a) => round(a, 0.0001))]) {
    if (!out.some((o) => turnBetween(o, h) < 0.002)) out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What every direction prefers

/**
 * The general preferences for a pose: move as little as the direction
 * allows, don't turn a piece without a reason, keep a table or a lamp square
 * to the room (a seat's heading is the direction's business), keep a piece
 * at the wall it stood against, don't tip the room's weight to one side —
 * and, dearer to work out and so kept apart, keep what it stood beside or in
 * front of, and what it faced, where that can still be true.
 */
function preferences(ctx: LayoutContext, goal: Goal, piece: SceneObject, home: Pose, working: Scene, relations: readonly Relationship[]) {
  const mine = relations.filter((r) => (r.subjectId === piece.id || r.objectId === piece.id) && r.predicate !== "on");
  const others = relationInputsExcept(working, piece.id);
  const byId = new Map(others.map((input) => [input.object.id, input]));
  const wasAgainst = wallBehind(ctx.scene, findById(ctx.scene.objects, piece.id)!) !== null;
  const role = ctx.roles.get(piece.id)!.role;
  const aimed = hasFront(piece) && role.endsWith("SEATING");
  // A floor lamp or a plant belongs at the room's edges, beside what it serves, not in the middle of the floor.
  const edge = role === "LIGHTING" || role === "DECOR";

  // The room's weight: plan area of the floor pieces, as a centre of mass.
  const centre = roomCentroid(working);
  const floor = working.objects.filter((o) => o.id !== piece.id && o.support.kind === "floor" && o.dimensions[1] > 0.05);
  const areaOf = (o: SceneObject) => o.dimensions[0] * o.transform.scale[0] * o.dimensions[2] * o.transform.scale[2];
  const mass = floor.reduce((s, o) => s + areaOf(o), 0);
  const moment: Vec2 = floor.reduce<Vec2>((s, o) => [s[0] + areaOf(o) * o.transform.position[0], s[1] + areaOf(o) * o.transform.position[2]], [0, 0]);
  const own = areaOf(piece);
  const lean = (at: Vec3) => Math.hypot((moment[0] + own * at[0]) / (mass + own) - centre[0], (moment[1] + own * at[2]) / (mass + own) - centre[1]);
  const leanBefore = lean(home.at);

  const cheap = (pose: Pose): number => {
    const turn = turnBetween(pose.rotationY, home.rotationY);
    let cost = goal.moveWeight * Math.hypot(pose.at[0] - home.at[0], pose.at[2] - home.at[2]) + PREFER.turn * turn;
    if (!aimed) cost += (PREFER.square * Math.min(...ctx.squared.map((a) => turnBetween(pose.rotationY, a)))) / (Math.PI / 4);
    if (wasAgainst && !wallBehind(working, piece, pose)) cost += PREFER.wall;
    if (edge) cost += PREFER.edge * Math.min(1.5, Math.max(0, nearestWallOf(working, footprintOf(piece, pose.at, pose.rotationY))?.gap ?? 0));
    cost += PREFER.balance * Math.max(0, lean(pose.at) - leanBefore);
    return cost;
  };

  const related = (pose: Pose): number => {
    if (mine.length === 0) return 0;
    const self: RelationInput = { object: atPose(piece, pose), front: frontOf(pose.rotationY), against: wallBehind(working, piece, pose)?.id ?? null, onWall: null };
    const all = [...others, self];
    const get = (id: Id) => (id === piece.id ? self : byId.get(id));
    let cost = 0;
    for (const r of mine) {
      const s = get(r.subjectId);
      const o = get(r.objectId);
      if (!s || !o) continue;
      if (r.predicate === "beside" && !isBeside(s, o)) cost += PREFER.beside;
      if (r.predicate === "in-front-of" && !isInFrontOf(s, o)) cost += PREFER.inFront;
      if (r.predicate === "faces" && facedBy(s, all)?.object.id !== o.object.id) cost += PREFER.faces;
      if (r.predicate === "above" && !isAbove(s, o)) cost += PREFER.above;
    }
    return cost;
  };

  return { cheap, related };
}

function relationInputsExcept(scene: Scene, id: Id): RelationInput[] {
  return scene.objects
    .filter((o) => o.id !== id)
    .map((object) => ({
      object,
      front: frontOf(object.transform.rotation[1]),
      against: wallBehind(scene, object)?.id ?? null,
      onWall: object.support.kind === "wall" ? object.support.wallId : null,
    }));
}

// ---------------------------------------------------------------------------

const samePose = (a: Pose, b: Pose) => Math.abs(a.at[0] - b.at[0]) < 0.0005 && Math.abs(a.at[2] - b.at[2]) < 0.0005 && turnBetween(a.rotationY, b.rotationY) < 0.0005;
