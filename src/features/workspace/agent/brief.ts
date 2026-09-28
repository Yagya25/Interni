import type { SceneEvidence } from "@/scene/compile/evidence";
import type { Scene } from "@/scene/model/types";
import { primarySeat, spatialRoles } from "../design/layout/roles";
import { basisOf, formatMeasurement, formatSeries, measureScene, measureWalkway, type Measured } from "../measure";

/**
 * The room, in words, for the design agent.
 * ================================================================
 *
 * Deterministic: the same Scene and evidence give the same text, byte for
 * byte, so the prompt prefix caches. Pieces are named by their labels —
 * never by id — and every number is Phase 5's, rounded to what is known and
 * said with how it is known. No photograph, pixels, paths or ids.
 */

const said = (m: Measured) => (m.available ? `${formatMeasurement(m)} (${basisOf(m)})` : "unknown");

export function roomBrief(scene: Scene, evidence: SceneEvidence | null, onScreen: readonly string[] = []): string {
  const m = measureScene(scene, evidence);
  const roles = new Map(spatialRoles(scene).map((r) => [r.id, r]));
  const lines: string[] = [];
  lines.push(`Room: ${m.source === "authored" ? "a demonstration room, authored rather than measured" : `reconstructed from one photograph; scale ${m.scale?.basis ?? "unknown"}`}.`);
  lines.push(`Size: ${formatSeries([m.room.width, m.room.depth, m.room.height])} (width × depth × height); floor ${said(m.room.floorArea)}.`);
  lines.push(`Free floor (not under furniture): ${said(m.floor.free)}. Circulation area (where a 60 cm path can run from the doorway): ${said(m.floor.circulation)}.`);

  lines.push("Pieces:");
  for (const piece of m.objects) {
    const role = roles.get(piece.id);
    const object = scene.objects.find((o) => o.id === piece.id)!;
    const parts = [`${object.category}`, role ? `${role.role.toLowerCase().replace(/_/g, " ")}, ${role.mobility}` : null, `size ${formatSeries([piece.size.width, piece.size.depth, piece.size.height])}`];
    if (piece.wall) parts.push(piece.wall.touching ? `against the ${piece.wall.label.toLowerCase()}` : `${formatMeasurement(piece.wall.gap)} from the ${piece.wall.label.toLowerCase()}`);
    if (piece.nearest) parts.push(`nearest ${piece.nearest.label} ${formatMeasurement(piece.nearest.distance)}`);
    if (piece.front) parts.push(`clear in front ${formatMeasurement(piece.front.depth)} to ${piece.front.endedBy.label}`);
    lines.push(`- ${piece.label}: ${parts.filter(Boolean).join("; ")}`);
  }

  lines.push("Openings:");
  for (const o of m.openings) {
    lines.push(`- ${o.label}: ${o.kind}${o.passage ? ", the way in" : ""}; ${formatMeasurement(o.width)} wide${o.intrusions.length ? `; standing in front of it: ${o.intrusions.map((i) => i.label).join(", ")}` : ""}`);
  }
  if (!m.openings.length) lines.push("- none");

  const seat = primarySeat(scene);
  if (seat) {
    const way = measureWalkway(scene, evidence, seat.id);
    lines.push(way.reachable ? `Way in to the ${seat.label.toLowerCase()}: ${formatMeasurement(way.width)} at its narrowest.` : `Way in to the ${seat.label.toLowerCase()}: ${way.reason}.`);
  }
  const lamps = scene.lights.filter((l) => l.kind === "artificial");
  if (lamps.length) lines.push(`Lamps: ${lamps.length}, ${lamps.filter((l) => l.kind === "artificial" && l.on === true).length} switched on.`);
  if (onScreen.length) lines.push(`Directions on screen now: ${onScreen.map((t, i) => `${i + 1}. ${t}`).join("; ")}.`);
  return lines.join("\n");
}
