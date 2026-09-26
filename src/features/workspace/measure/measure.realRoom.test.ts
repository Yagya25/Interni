import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { applyOperations } from "@/scene/model/operations";
import { findById } from "@/scene/model/queries";
import type { Scene } from "@/scene/model/types";
import { circulationOf } from "../design/layout/circulation";
import { generateProposals } from "../design/generate";
import { validateDesignIntent } from "../design/intent";
import { readBrief } from "../design/read";
import { answer, computeMeasurements, formatMeasurement, formatSeries, knowledgeOf, measureWalkway, type Measured, type Measurement } from "./index";

/**
 * Measurements of the room in the photograph.
 *
 * The real worker output for download.png, compiled exactly as the browser
 * compiles it. The room has no ground truth — nobody has tape-measured it —
 * so this is not an accuracy check: it checks that every number agrees with
 * the Scene and the evidence it came from, that the room's own gaps come out
 * as its geometry has them, and that nothing claims more than the
 * reconstruction knows: uncalibrated, one side of the room unseen, one
 * armchair entirely a typical size.
 */
const FIXTURE = new URL("../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);

function compiled() {
  const parsed = parseIntermediate(JSON.parse(readFileSync(FIXTURE, "utf8")));
  if (parsed.kind !== "run") throw new Error("the fixture is not a run");
  const result = compileRoomShell(parsed.intermediate);
  if (!result.ok) throw new Error(result.problem.code);
  return result;
}

const { scene: ROOM, evidence: EVIDENCE } = compiled();
const M = computeMeasurements(ROOM, EVIDENCE);
const got = (m: Measured): Measurement => {
  if (!m.available) throw new Error(`unavailable: ${m.reason}`);
  return m;
};
const piece = (id: string) => M.objects.find((o) => o.id === id)!;

describe("the real room, measured", () => {
  it("reads the room's size from the Scene with the evidence's own bases", () => {
    const f = EVIDENCE.entities.room.fields;
    // The compiler rounds each corner to the millimetre, and the recorded size once: they may differ by 1 mm,
    // which is not an edit.
    for (const [m, field] of [[M.room.width, f.width], [M.room.depth, f.depth], [M.room.height, f.height]] as const) {
      expect(Math.abs(got(m).value - (field.value as number))).toBeLessThanOrEqual(0.001 + 1e-9);
      expect(got(m).edited).toBe(false);
    }
    // Both side walls and the ceiling were seen; the wall behind the camera was not, so the depth is a default.
    expect(got(M.room.width).basis).toBe("estimated");
    expect(got(M.room.height).basis).toBe("estimated");
    expect(got(M.room.depth).basis).toBe("default");
    expect(got(M.room.floorArea).basis).toBe("default");
    expect(M.scale).toEqual({ basis: "estimated", references: 0, logSigma: null });
    expect(formatSeries([M.room.width, M.room.depth, M.room.height])).toBe("≈ 3.7 × 6.4 × 3.0 m");
  });

  it("keeps free floor and circulation area apart, each consistent with its own definition", () => {
    const { area, free, occupied, circulation } = M.floor;
    expect(got(free).value + got(occupied).value).toBeCloseTo(got(area).value, 9);
    // The exact free floor agrees with the layout heuristic's own 10 cm grid count, within that grid's error.
    const grid = circulationOf(ROOM);
    expect(Math.abs(got(free).value - grid.openArea)).toBeLessThan(0.5);
    // Circulation is the heuristic's walkable floor, unchanged — and far smaller than the free floor.
    expect(got(circulation).value).toBe(grid.walkableArea);
    expect(M.floor.circulationFrom).toBe(grid.from);
    expect(got(circulation).value).toBeLessThan(got(free).value / 2);
    expect(formatMeasurement(free)).toBe("≈ 18 m²");
  });

  it("says which sizes were seen, which in part, and which are typical", () => {
    const sofa = piece("sofa-0");
    expect(got(sofa.size.width)).toMatchObject({ basis: "estimated", bound: "at-least" });
    expect(got(sofa.size.depth)).toMatchObject({ basis: "estimated", bound: "value" });
    expect(formatMeasurement(sofa.size.width)).toBe("at least ≈ 2.2 m");
    // Armchair 1 was cut off by the edge of the photo: all three of its sizes are an armchair's typical ones.
    const chair = piece("armchair-0");
    for (const axis of [chair.size.width, chair.size.depth, chair.size.height]) expect(got(axis)).toMatchObject({ basis: "inferred", bound: "typical" });
    // The chair's depth was not seen either.
    expect(got(piece("chair-0").size.depth).bound).toBe("typical");
    for (const o of M.objects) {
      const object = findById(ROOM.objects, o.id)!;
      expect(got(o.size.width).value).toBeCloseTo(object.dimensions[0], 9);
      expect(got(o.size.height).value).toBeCloseTo(object.dimensions[1], 9);
    }
  });

  it("finds what the room's geometry has: the sofa against the left wall, the table in front of it, the armchair at the glazed door", () => {
    const sofa = piece("sofa-0");
    expect(sofa.wall).toMatchObject({ wallId: "wall-left", touching: true });
    expect(piece("media-console-0").wall).toMatchObject({ wallId: "wall-right", touching: true });
    expect(piece("television-0").wall).toMatchObject({ wallId: "wall-right", touching: true });
    const k = knowledgeOf(ROOM, EVIDENCE);
    const table = answer(ROOM, EVIDENCE, { kind: "distance", from: "sofa-0", to: "coffee-table-0" });
    expect(table).toMatchObject({ ok: true });
    expect(k.evidence).not.toBeNull();
    // The glazed door is walked through, and Armchair 2 stands in its clear zone — as the layout heuristic also finds.
    const door = M.openings.find((o) => o.id === "window-0")!;
    expect(door).toMatchObject({ label: "Glazed door", passage: true });
    expect(door.clearDepth!.endedBy).toMatchObject({ id: "armchair-1" });
    const blocked = circulationOf(ROOM).passages.find((p) => p.openingId === "window-0")!.blockedBy;
    for (const id of blocked) expect(door.intrusions.map((i) => i.id)).toContain(id);
    expect(blocked).toContain("armchair-1");
  });

  it("measures the way in: narrowest between the glazed door's frame and the armchair in front of it", () => {
    const way = measureWalkway(ROOM, EVIDENCE, "sofa-0");
    if (!way.reachable) throw new Error(way.reason);
    expect(way.from).toBe("window-0");
    expect(way.between.map((b) => b.id ?? b.label).sort()).toEqual(["armchair-1", "wall-far"]);
    expect(way.between.find((b) => b.id === "wall-far")!.label).toBe("Glazed door frame");
    expect(got(way.width).value).toBeGreaterThan(0.45);
    expect(got(way.width).value).toBeLessThan(0.65);
    const verdict = answer(ROOM, EVIDENCE, { kind: "circulation-at-least", metres: 0.8 });
    expect(verdict).toMatchObject({ ok: true, verdict: "no" });
  });

  it("claims no precision the reconstruction does not have", () => {
    const all: Measured[] = [
      ...Object.values(M.room),
      M.floor.area,
      M.floor.free,
      M.floor.occupied,
      M.floor.circulation,
      ...M.objects.flatMap((o) => [o.size.width, o.size.depth, o.size.height, o.bounds.across, o.bounds.along, o.bounds.top, ...(o.wall ? [o.wall.gap] : []), ...(o.nearest ? [o.nearest.distance] : []), ...(o.front ? [o.front.depth] : [])]),
      ...M.openings.flatMap((o) => [o.width, o.height, o.sill, ...(o.clearDepth ? [o.clearDepth.depth] : []), ...o.intrusions.map((i) => i.depth)]),
    ];
    for (const m of all.filter((x): x is Measurement => x.available)) {
      // Uncalibrated: nothing is measured or calibrated, no σ, interval or confidence is claimed…
      expect(["estimated", "inferred", "default"]).toContain(m.basis);
      expect(m).toMatchObject({ sigma: null, interval: null, confidence: null, edited: false });
      // …and nothing is shown finer than 5 cm, or 0.5 m² for an area.
      expect(m.resolution).toBeGreaterThanOrEqual(m.unit === "m²" ? 0.5 : 0.05);
    }
  });

  it("measures an applied layout as the design it is, and the room it came from as found", () => {
    const checked = validateDesignIntent(readBrief("Give me three furniture layouts."));
    if (!checked.ok) throw new Error(checked.reason);
    const result = generateProposals(ROOM, checked.intent);
    if (!result.ok) throw new Error(result.reason);
    const layout = result.proposals[0];
    const moved = new Set(layout.operations.flatMap((op) => (op.kind === "move" ? [op.objectId] : [])));
    expect(moved.size).toBeGreaterThan(0);
    const before = JSON.stringify(ROOM);
    const designed: Scene = applyOperations(ROOM, layout.operations);
    const m = computeMeasurements(designed, EVIDENCE);
    // Measuring changed nothing in the room.
    expect(JSON.stringify(ROOM)).toBe(before);
    for (const o of m.objects) {
      const nearest = o.nearest?.distance;
      if (moved.has(o.id) && nearest?.available) expect(nearest.edited).toBe(true);
      // Moving a piece does not change what is known of its size.
      if (o.size.width.available) expect(o.size.width.edited).toBe(false);
    }
    expect(got(m.room.width).edited).toBe(false);
    expect(got(m.floor.free).edited).toBe(true);
    // The room, measured as found, is untouched by the design.
    expect(JSON.stringify(computeMeasurements(ROOM, EVIDENCE))).toBe(JSON.stringify(M));
  });

  it("is the same every time", () => {
    const again = compiled();
    expect(JSON.stringify(computeMeasurements(again.scene, again.evidence))).toBe(JSON.stringify(M));
  });
});
