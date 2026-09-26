import type { SceneOperation } from "@/scene/model/operations";
import { findById, walls } from "@/scene/model/queries";
import type { Scene } from "@/scene/model/types";
import { collision, footprintOf, insideRoom } from "../../ai/rules/spatial";
import { circulationOf } from "./circulation";
import { distanceToFootprint, gapToWall, intrusion, PASSAGE, passageZones } from "./geometry";
import { spatialRoles, whyItStays } from "./roles";

/**
 * Nothing is shown that the room cannot physically take.
 * ================================================================
 *
 * The hard constraints on a layout, checked on the arrangement it would
 * leave — not on the planner's good intentions — so any generator, a
 * future model included, is held to the same room:
 *
 * - only pieces free to move are moved: not walls, floor, ceiling or
 *   openings; not what hangs on a wall or from the ceiling; not tall storage
 *   at its wall or the piece a screen hangs over; a carried piece only with
 *   what carries it, and still on it;
 * - a floor piece stays on the floor, upright;
 * - every moved piece is inside the room and through no wall;
 * - no moved piece passes through another;
 * - no moved piece stands further into a doorway than it already did;
 * - no seat a person could reach is shut in, and no way in is cut off.
 *
 * A piece the plan did not touch is not re-judged: a proposal answers for
 * what it does, not for how the compiler read the photograph.
 */

export type LayoutCheck = { ok: true } | { ok: false; reason: string };

export function validateLayout(before: Scene, after: Scene, operations: readonly SceneOperation[]): LayoutCheck {
  const moves = operations.filter((op): op is Extract<SceneOperation, { kind: "move" }> => op.kind === "move");
  if (moves.length === 0) return { ok: true };
  const roles = new Map(spatialRoles(before).map((r) => [r.id, r]));
  const movedIds = new Set(moves.map((op) => op.objectId));

  for (const id of movedIds) {
    const was = findById(before.objects, id);
    const now = findById(after.objects, id);
    if (!was || !now) return fail(`there is no object ${id} in this room`);
    const name = was.label.toLowerCase();
    const role = roles.get(id)!;
    if (role.mobility === "carried") {
      const carrier = was.support.kind === "object" ? was.support.objectId : null;
      if (!carrier || !movedIds.has(carrier)) return fail(`the ${name} stands on another piece and moves only with it`);
      const under = findById(after.objects, carrier);
      if (!under || distanceToFootprint(now.transform.position[0], now.transform.position[2], footprintOf(under)) > 0.005) return fail(`the ${name} would be left off the piece that carries it`);
      continue;
    }
    if (role.mobility !== "movable") return fail(`the ${name} stays where it is: ${whyItStays(role)}`);

    const [x, y, z] = now.transform.position;
    if (![x, y, z, ...now.transform.rotation].every(Number.isFinite)) return fail(`the ${name} would be moved nowhere finite`);
    if (y !== was.transform.position[1] || now.transform.rotation[0] !== was.transform.rotation[0] || now.transform.rotation[2] !== was.transform.rotation[2]) {
      return fail(`the ${name} would be lifted or tipped off the floor`);
    }
    const f = footprintOf(now);
    if (!insideRoom(after, f)) return fail(`the ${name} would end up outside the room`);
    for (const wall of walls(after)) {
      if (gapToWall(after, wall, f) < -0.005) return fail(`the ${name} would pass through the ${wall.label.toLowerCase()}`);
    }
    const hit = collision(after, now, f);
    if (hit) return fail(`the ${name} would run into the ${hit.label.toLowerCase()}`);
    for (const { opening, zone } of passageZones(after)) {
      const was_ = intrusion(footprintOf(was), zone);
      if (intrusion(f, zone) > Math.max(PASSAGE.tolerance, was_) + 1e-6) return fail(`the ${name} would stand in the way of the ${opening.label.toLowerCase()}`);
    }
  }

  const then = circulationOf(before);
  const now = circulationOf(after);
  for (const seat of now.seats) {
    const was = then.seats.find((s) => s.id === seat.id);
    if (was?.reachable && !seat.reachable) return fail(`the ${findById(after.objects, seat.id)!.label.toLowerCase()} would be shut in, with no way to reach it`);
  }
  for (const passage of now.passages) {
    const was = then.passages.find((p) => p.openingId === passage.openingId);
    if (was?.reachable && !passage.reachable) return fail(`the way to the ${findById(after.openings, passage.openingId)!.label.toLowerCase()} would be cut off`);
  }
  return { ok: true };
}

const fail = (reason: string): LayoutCheck => ({ ok: false, reason });
