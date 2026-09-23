import { describe, expect, it } from "vitest";
import { findById } from "@/scene/model/queries";
import { compileRoomShell } from "./compileRoomShell";
import type { CompileResult } from "./evidence";
import { parseIntermediate } from "./intermediate";
import { DEFAULT_ROOM, syntheticInstances, syntheticIntermediate } from "./__fixtures__/synthetic";

const ROOM = { ...DEFAULT_ROOM, scaleError: 1 };

function compiled(result: CompileResult) {
  if (!result.ok) throw new Error(`compile failed: ${result.problem.code}`);
  return result;
}

const furnished = () => compiled(compileRoomShell(syntheticIntermediate({ scaleError: 1 }, syntheticInstances)));
const object = (r: ReturnType<typeof furnished>, id: string) => {
  const o = findById(r.scene.objects, id);
  if (!o) throw new Error(`no ${id}; have ${r.scene.objects.map((x) => x.id).join(", ")}`);
  return o;
};

describe("objects from observations", () => {
  it("parses instance observations and refuses a malformed one", () => {
    const input = syntheticIntermediate({ scaleError: 1 }, syntheticInstances);
    expect(parseIntermediate(input).kind).toBe("run");
    const broken = { ...input, world: { ...input.world, instances: [{ ...input.world.instances[0], labels: [] }] } };
    expect(parseIntermediate(broken)).toEqual({ kind: "invalid", reason: "instances[0].labels must not be empty" });
  });

  it("emits only what was seen above the bar, and says what happened to the rest", () => {
    const { scene, report } = furnished();
    expect(scene.objects.map((o) => o.id).sort()).toEqual(["artwork-0", "coffee-table-0", "plant-0", "sofa-0", "television-0"]);
    const objects = report.objects!;
    expect(objects.candidates.map((c) => c.instance)).toEqual(["instance-7"]);
    expect(objects.notModelled.map((c) => [c.instance, c.label])).toEqual([["instance-8", "ceiling fan"]]);
    expect(Object.fromEntries(objects.rejected.map((r) => [r.instance, r.reason]))).toEqual({
      "instance-6": expect.stringMatching(/not set in one of the room's walls/),
      "instance-9": expect.stringMatching(/mask not trusted/),
    });
    // Every object traces to exactly one instance.
    for (const o of scene.objects) expect(o.metadata?.instance).toMatch(/^instance-\d$/);
  });

  it("stands a sofa on the floor against its wall, completing the depth it could not see", () => {
    const r = furnished();
    const sofa = object(r, "sofa-0");
    const left = r.report.sides.left.position;
    expect(sofa.support).toEqual({ kind: "floor" });
    expect(sofa.transform.position[1]).toBe(0);
    // Faces away from the left wall: +X, a quarter turn.
    expect(sofa.transform.rotation[1]).toBeCloseTo(Math.PI / 2, 3);
    // 2.0 m long as seen, 0.85 m tall; depth 0.9 m from the prior, back against the wall.
    expect(sofa.dimensions).toEqual([2, 0.85, 0.9]);
    expect(sofa.transform.position[0]).toBeCloseTo(left + 0.46, 3);
    expect(sofa.metadata?.seatHeight).toBe(0.45);
    const fields = r.evidence.entities["sofa-0"].fields;
    expect(fields["dimensions.0"].basis).toBe("estimated");
    expect(fields["dimensions.2"].basis).toBe("inferred");
    expect(fields.category.note).toMatch(/raw score/);
  });

  it("places things by depth where they stand, and on what carries them", () => {
    const r = furnished();
    const table = object(r, "coffee-table-0");
    const plant = object(r, "plant-0");
    expect(table.dimensions).toEqual([0.6, 0.42, 1.1]);
    expect(plant.support).toEqual({ kind: "object", objectId: "coffee-table-0" });
    expect(plant.transform.position[1]).toBeCloseTo(0.42, 3);
    expect(plant.dimensions[1]).toBeCloseTo(0.95 - 0.42, 3);
    // The table's centre is where its points were, relative to the sofa.
    const sofa = object(r, "sofa-0");
    expect(table.transform.position[2]).toBeCloseTo(sofa.transform.position[2], 2);
    expect(table.transform.position[0] - sofa.transform.position[0]).toBeGreaterThan(0.8);
  });

  it("hangs a TV and a picture on their walls, measured on the wall plane", () => {
    const r = furnished();
    const tv = object(r, "television-0");
    const art = object(r, "artwork-0");
    expect(tv.support).toEqual({ kind: "wall", wallId: "wall-far" });
    expect(tv.metadata?.mount).toBe("wall");
    expect(tv.dimensions[0]).toBeCloseTo(1.2, 3);
    expect(tv.transform.position[1]).toBeCloseTo(0.9, 3);
    expect(art.support).toEqual({ kind: "wall", wallId: "wall-left" });
    expect(art.dimensions[0]).toBeCloseTo(0.6, 3);
    expect(art.dimensions[1]).toBeCloseTo(0.5, 3);
  });

  it("sets a window in its wall and lets daylight through it", () => {
    const r = furnished();
    expect(r.scene.openings).toHaveLength(1);
    const w = r.scene.openings[0];
    expect(w).toMatchObject({ id: "window-0", kind: "window", wallId: "wall-far" });
    expect(w.width).toBeCloseTo(0.9, 3);
    expect(w.sill).toBeCloseTo(0.9, 3);
    expect(w.height).toBeCloseTo(1.3, 3);
    const far = r.scene.surfaces.find((s) => s.id === "wall-far")!;
    if (far.kind !== "wall") throw new Error("not a wall");
    // Offset from the wall's start: the window spans x 1.0..1.9 in room axes.
    expect(far.start[0] + w.offset).toBeCloseTo(1.45 - r.report.frame.translation[0] * -1, 2);
    expect(r.scene.lights.find((l) => l.kind === "daylight")).toMatchObject({ openingIds: ["window-0"] });
  });

  it("records the relationships the placements imply", () => {
    const r = furnished();
    const rel = r.scene.relationships.map((x) => `${x.subjectId} ${x.predicate} ${x.objectId}`);
    expect(rel).toEqual(
      expect.arrayContaining([
        "plant-0 on coffee-table-0",
        "sofa-0 against wall-left",
        "artwork-0 above sofa-0",
        "coffee-table-0 in-front-of sofa-0",
      ]),
    );
    expect(new Set(r.scene.relationships.map((x) => x.id)).size).toBe(r.scene.relationships.length);
  });

  it("compiles objects deterministically, and keeps their ids through recalibration", () => {
    const input = syntheticIntermediate({ scaleError: 1 }, syntheticInstances);
    const a = JSON.stringify(compileRoomShell(input));
    expect(JSON.stringify(compileRoomShell(structuredClone(input)))).toBe(a);
    const scaled = compiled(compileRoomShell(input, { calibration: [{ kind: "room-height", metres: ROOM.height * 1.1 }] }));
    expect(scaled.scene.objects.map((o) => o.id)).toEqual(furnished().scene.objects.map((o) => o.id));
    expect(object(scaled, "sofa-0").dimensions[0]).toBeCloseTo(2.2, 3);
  });

  it("can compile the shell alone", () => {
    const r = compiled(compileRoomShell(syntheticIntermediate({ scaleError: 1 }, syntheticInstances), { objects: false }));
    expect(r.scene.objects).toEqual([]);
    expect(r.report.objects).toBeNull();
  });
});
