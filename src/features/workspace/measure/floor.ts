import { CIRCULATION, circulationOf, obstaclesOf } from "../design/layout/circulation";
import { isPassage } from "../design/layout/geometry";
import { isPolygon, polygonArea, polygonOf, unionAreaWithin } from "./geometry";
import { footprintInputs, openingInput, roomInput, withScale, type Knowledge } from "./provenance";
import { measurement, unavailable, type Measured, type MeasuredInput } from "./types";

/**
 * The floor, in two different senses.
 * ================================================================
 *
 * Free floor and circulation area are different measurements, and neither
 * stands in for the other:
 *
 * - **Free floor** is geometric: the floor inside the room that no standing
 *   piece covers. Exact — the pieces' turned footprints, their union counted
 *   once, clipped to the room. A rug, or anything as flat, is walked on and
 *   does not take floor (the same rule the circulation heuristic uses).
 *
 * - **Circulation area** is the Phase 4B path heuristic (`circulation.ts`,
 *   `circulation-0.1`), read unchanged: the floor on a 10 cm grid where the
 *   centre of a 60 cm wide path can be — 30 cm clear of every piece and wall
 *   — reached from a doorway. It is a design heuristic, much smaller than
 *   the free floor by construction, and is what the layout planner's
 *   "walkable floor" means. It is reported here under that definition, not
 *   reinterpreted.
 */

export interface FloorMeasurements {
  /** The whole floor inside the room's footprint. */
  area: Measured;
  /** Floor not under any standing piece. */
  free: Measured;
  /** Floor under standing pieces: their union inside the room. */
  occupied: Measured;
  /** Where the centre of a 60 cm path can reach, by the circulation heuristic. */
  circulation: Measured;
  /** Where that path was started: a doorway, or the largest open region when the room has none. */
  circulationFrom: "passage" | "largest-region" | null;
}

/** What the floor readings rest on: the room's size and every standing piece's footprint. */
function floorInputs(k: Knowledge): MeasuredInput[] {
  return withScale(k, [roomInput(k, "width"), roomInput(k, "depth"), ...obstaclesOf(k.scene).flatMap(({ object }) => footprintInputs(k, object))]);
}

export function measureFloor(k: Knowledge): FloorMeasurements {
  const room = k.scene.room.footprint;
  if (!isPolygon(room)) {
    const no = unavailable("the room's footprint is not a closed outline with an area");
    return { area: no, free: no, occupied: no, circulation: no, circulationFrom: null };
  }
  const obstacles = obstaclesOf(k.scene);
  const polygons = obstacles.map(({ footprint }) => polygonOf(footprint));
  if (!polygons.every((p) => p.every((v) => Number.isFinite(v[0]) && Number.isFinite(v[1])))) {
    const no = unavailable("a standing piece's footprint is not a usable shape");
    return { area: measurement(polygonArea(room), "m²", ["room", "floor"], withScale(k, [roomInput(k, "width"), roomInput(k, "depth")])), free: no, occupied: no, circulation: no, circulationFrom: null };
  }

  const total = polygonArea(room);
  const under = unionAreaWithin(polygons, room);
  const inputs = floorInputs(k);
  const pieces = obstacles.map(({ object }) => object.id);
  const circulation = circulationOf(k.scene);
  const doorways = k.scene.openings.filter(isPassage);
  const pathInputs = [...inputs, ...doorways.flatMap((o) => [openingInput(k, o, "width"), openingInput(k, o, "height"), openingInput(k, o, "sill")])];

  return {
    area: measurement(total, "m²", ["room", "floor"], withScale(k, [roomInput(k, "width"), roomInput(k, "depth")])),
    free: measurement(total - under, "m²", ["floor", ...pieces], inputs, { rule: "free-floor", note: "floor not under any standing piece; flat things such as rugs are walked on" }),
    occupied: measurement(under, "m²", ["floor", ...pieces], inputs, { rule: "occupied-floor", note: "the standing pieces' footprints, overlaps counted once" }),
    circulation: measurement(circulation.walkableArea, "m²", ["floor", ...pieces, ...doorways.map((o) => o.id)], pathInputs, {
      rule: CIRCULATION.version,
      note: `where the centre of a ${Math.round(CIRCULATION.clearance * 200)} cm path can be, reached from ${circulation.from === "passage" ? "a doorway" : "the largest open region (the room has no doorway)"}; a design heuristic on a ${Math.round(CIRCULATION.cell * 100)} cm grid`,
    }),
    circulationFrom: circulation.from,
  };
}
