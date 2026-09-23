import { describe, expect, it } from "vitest";
import { roomBounds, walls } from "@/scene/model/queries";
import { summarizeScene } from "@/scene/model/summary";
import type { CalibrationReference } from "./calibration";
import { compileRoomShell } from "./compileRoomShell";
import type { CompileResult } from "./evidence";
import { parseIntermediate } from "./intermediate";
import { DEFAULT_ROOM, project, syntheticIntermediate, truePoint } from "./__fixtures__/synthetic";

function compiled(result: CompileResult) {
  if (!result.ok) throw new Error(`compile failed: ${result.problem.code}`);
  return result;
}

/** A 0.9 m span on the far wall, at 1 m height, as a person would mark it on the photo. */
function doorWidth(room = DEFAULT_ROOM, metres = 0.9): Extract<CalibrationReference, { kind: "on-plane" }> {
  const z = room.box[2];
  return {
    kind: "on-plane",
    planeId: "plane-2",
    a: project(room, truePoint(room, [0.2, 1.0, z])),
    b: project(room, truePoint(room, [0.2 + metres, 1.0, z])),
    metres,
    label: "door width",
  };
}

describe("compileRoomShell", () => {
  it("builds the room shell from observed walls, and closes the rest honestly", () => {
    const { scene, report, evidence } = compiled(compileRoomShell(syntheticIntermediate()));
    const k = DEFAULT_ROOM.scaleError;

    // Uncalibrated: every length is the depth model's, 0.9 × the truth.
    expect(report.sides.left.status).toBe("observed");
    expect(report.sides.far.status).toBe("observed");
    expect(report.sides.right.status).toBe("inferred");
    expect(report.sides.behind.status).toBe("omitted");
    expect(scene.room.height).toBeCloseTo(2.7 * k, 3);
    expect(report.dimensions.width.value).toBeCloseTo(3.9 * k, 3);
    expect(report.dimensions.width.basis).toBe("inferred");
    expect(report.dimensions.height.basis).toBe("estimated");
    expect(evidence.scale).toMatchObject({ factor: 1, basis: "estimated", logSigma: null });

    // Walls run along the axes, the far one at the room's −Z edge.
    const ids = walls(scene).map((w) => [w.id, w.evidence]);
    expect(ids).toEqual([
      ["wall-far", "observed"],
      ["wall-left", "observed"],
      ["wall-right", "inferred"],
    ]);
    for (const w of walls(scene)) expect(w.start[0] === w.end[0] || w.start[1] === w.end[1]).toBe(true);

    // The footprint is centred, as the demo room's is.
    const b = roomBounds(scene);
    expect(b.min[0] + b.max[0]).toBeCloseTo(0, 6);
    expect(b.min[2] + b.max[2]).toBeCloseTo(0, 6);
  });

  it("places the camera where it stood and points it where it looked", () => {
    const { scene } = compiled(compileRoomShell(syntheticIntermediate()));
    const [x, y, z] = scene.camera.position;
    const [tx, ty, tz] = scene.camera.target;
    expect(y).toBeCloseTo(DEFAULT_ROOM.cameraHeight * DEFAULT_ROOM.scaleError, 3);
    // Looking down 12° and 25° to the left of the far wall's normal.
    const pitch = (Math.atan2(ty - y, Math.hypot(tx - x, tz - z)) * 180) / Math.PI;
    const yaw = (Math.atan2(tx - x, -(tz - z)) * 180) / Math.PI;
    expect(pitch).toBeCloseTo(-12, 1);
    expect(yaw).toBeCloseTo(-25, 1);
    expect(scene.camera.verticalFov).toBeCloseTo((2 * Math.atan(600 / 1100) * 180) / Math.PI, 2);
    expect(scene.camera.aspect).toBeCloseTo(4 / 3, 4);
  });

  it("is deterministic to the byte", () => {
    const input = syntheticIntermediate();
    const a = JSON.stringify(compileRoomShell(input));
    const b = JSON.stringify(compileRoomShell(structuredClone(input)));
    expect(a).toBe(b);
  });

  it("claims nothing it did not see", () => {
    const { scene, evidence } = compiled(compileRoomShell(syntheticIntermediate()));
    expect(scene.objects).toEqual([]);
    expect(scene.openings).toEqual([]);
    expect(scene.provenance.kind).toBe("reconstruction");
    expect(scene.room.type).toBe("other");
    for (const m of scene.materials) {
      expect(m.name).toMatch(/not estimated/);
      expect(evidence.entities[m.id].presence.basis).toBe("default");
    }
    expect(summarizeScene(scene).inferredSurfaces).toBe(1);
  });

  it("infers the height when the ceiling was not seen, and says so", () => {
    const { scene, report } = compiled(compileRoomShell(syntheticIntermediate({ ceiling: false })));
    expect(scene.surfaces.find((s) => s.id === "ceiling")?.evidence).toBe("inferred");
    // Highest wall top seen is 2.6 × 0.9 = 2.34 m, below the 2.5 m default.
    expect(scene.room.height).toBe(2.5);
    expect(report.dimensions.height.basis).toBe("default");
    expect(report.problems.map((p) => p.code)).toContain("ceiling-not-seen");
  });

  it("fails with a named problem when there is no floor", () => {
    const input = syntheticIntermediate();
    const noFloor = { ...input, world: { ...input.world, planes: input.world.planes.filter((p) => p.role !== "floor") } };
    const result = compileRoomShell(noFloor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe("no-floor");
  });

  it("bounds a side by its largest wall, not by what is seen through a window", () => {
    const input = syntheticIntermediate();
    const far = input.world.planes.find((p) => p.id === "plane-2")!;
    // A small facade 5 m beyond the far wall, as through a glass door.
    const beyond = { ...far, id: "plane-9", visibleArea: 1.2, offset: far.offset + 5, centroid: [far.centroid[0], far.centroid[1], far.centroid[2] - 5] as const };
    const withView = { ...input, world: { ...input.world, planes: [...input.world.planes, beyond] } };
    const { report } = compiled(compileRoomShell(withView));
    expect(report.sides.far.planeId).toBe("plane-2");
    expect(report.planes.ignored.find((p) => p.id === "plane-9")?.reason).toMatch(/smaller than the far wall/);
  });

  it("reports roll it cannot represent", () => {
    const result = compiled(compileRoomShell(syntheticIntermediate({ rollDeg: 3 })));
    expect(result.report.problems.map((p) => p.code)).toContain("camera-roll-dropped");
  });

  it("aligns the room to the axes whatever way the camera faced it", () => {
    for (const yawDeg of [-40, -10, 0, 18, 44]) {
      const { report, scene } = compiled(compileRoomShell(syntheticIntermediate({ yawDeg })));
      expect(report.frame.yawDeg).toBeCloseTo(yawDeg, 2);
      expect(scene.room.height).toBeCloseTo(2.7 * 0.9, 3);
    }
  });
});

describe("calibration", () => {
  it("rescales the whole room from one measurement, without any model", () => {
    const input = syntheticIntermediate();
    const before = compiled(compileRoomShell(input));
    const after = compiled(compileRoomShell(input, { calibration: [doorWidth()] }));

    expect(after.evidence.scale.basis).toBe("calibrated");
    expect(after.evidence.scale.factor).toBeCloseTo(1 / DEFAULT_ROOM.scaleError, 5);
    // The truth comes back: 2.7 m ceiling, far wall 4.6 m in front of the camera.
    expect(after.scene.room.height).toBeCloseTo(2.7, 3);
    expect(after.report.dimensions.height.basis).toBe("calibrated");
    const far = after.report.sides.far.position - after.scene.camera.position[2];
    expect(far).toBeCloseTo(-4.6, 2);
    expect(after.scene.camera.position[1]).toBeCloseTo(1.45, 3);
    // Observed width sides are calibrated; the inferred side keeps its basis.
    expect(after.report.dimensions.width.value).toBeCloseTo(3.9, 3);
    expect(after.report.dimensions.width.basis).toBe("inferred");

    // Ids do not move, so a selection or a history survives recalibration.
    const ids = (r: typeof before) => r.scene.surfaces.map((s) => s.id);
    expect(ids(after)).toEqual(ids(before));
    // Angles do not scale.
    expect(after.scene.camera.verticalFov).toBe(before.scene.camera.verticalFov);
  });

  it("does not hard-code the measurement", () => {
    const after = compiled(compileRoomShell(syntheticIntermediate(), { calibration: [doorWidth(DEFAULT_ROOM, 1.2)] }));
    expect(after.scene.room.height).toBeCloseTo(2.7, 3);
    const halfTruth = compiled(
      compileRoomShell(syntheticIntermediate(), { calibration: [{ ...doorWidth(DEFAULT_ROOM, 1.2), metres: 0.6 }] }),
    );
    // The same span said to be half as long halves the room.
    expect(halfTruth.scene.room.height).toBeCloseTo(1.35, 3);
  });

  it("fuses several references and shows how far they disagree", () => {
    // The ceiling said to be 20% taller than the door width implies.
    const refs: CalibrationReference[] = [doorWidth(), { kind: "room-height", metres: 2.7 * 1.2, label: "ceiling" }];
    const result = compiled(compileRoomShell(syntheticIntermediate(), { calibration: refs }));
    expect(result.evidence.scale.residuals).toHaveLength(2);
    expect(Math.abs(result.evidence.scale.residuals[0])).toBeCloseTo(Math.log(1.2) / 2, 4);
    expect(result.report.problems.map((p) => p.code)).toContain("calibration-references-disagree");
  });

  it("rejects references it cannot use, and stays uncalibrated", () => {
    const refs: CalibrationReference[] = [
      { ...doorWidth(), planeId: "plane-99" },
      { ...doorWidth(), metres: -1 },
    ];
    const result = compiled(compileRoomShell(syntheticIntermediate({ ceiling: false }), { calibration: [...refs, { kind: "room-height", metres: 2.6 }] }));
    expect(result.evidence.scale.basis).toBe("estimated");
    expect(result.report.problems.filter((p) => p.code === "calibration-reference-rejected")).toHaveLength(3);
  });
});

describe("parseIntermediate", () => {
  it("accepts what the worker writes and refuses what it does not", () => {
    expect(parseIntermediate(syntheticIntermediate()).kind).toBe("run");
    expect(parseIntermediate({ ...syntheticIntermediate(), schemaVersion: 2 })).toEqual({
      kind: "invalid",
      reason: "unsupported schemaVersion 2",
    });
    const broken = syntheticIntermediate();
    const result = parseIntermediate({ ...broken, world: { ...broken.world, planes: [{ ...broken.world.planes[0], normal: [0, 1] }] } });
    expect(result).toEqual({ kind: "invalid", reason: "planes[0].normal must be 3 numbers" });
  });

  it("recognises a failed run", () => {
    const failed = {
      schemaVersion: 1,
      jobId: "x",
      createdAt: "2026-09-22T00:00:00Z",
      diagnostics: { status: "failed", warnings: [], errors: [{ code: "no-floor" }] },
    };
    expect(parseIntermediate(failed).kind).toBe("failed");
  });
});
