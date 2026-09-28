import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileRoomShell, parseIntermediate, type ReconstructionIntermediate } from "@/scene/compile";
import { estimateOf, type CalibrationReference } from "@/scene/compile/calibration";
import type { Scene } from "@/scene/model/types";
import { generateProposals } from "../../design/generate";
import { validateDesignIntent } from "../../design/intent";
import { circulationOf } from "../../design/layout";
import { readBrief } from "../../design/read";
import { measureScene } from "../../measure";
import { WorkspaceStore } from "../../state/store";
import { notConnected } from "../../ai/interpreter";
import { saveCalibration } from "../calibrationFile";
import { recompile, type RunState } from "../loadRun";
import { measureMarks, planeAt, planeName, previewCalibration, roomHeightReference, type PlaneLabelMap } from "./calibrate";
import { explainRun } from "./diagnostics";
import { objectEvidence, readSource, roomEvidence } from "./evidence";

/**
 * Phase 8: reconstruction trust and calibration, on the real reconstruction
 * (download.png, run 20260922T065240Z-2d25a689: degraded, fov-disagreement).
 */

const FIXTURE = new URL("../../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);
const TEXT = readFileSync(FIXTURE, "utf8");
const RUN = (): ReconstructionIntermediate => {
  const parsed = parseIntermediate(JSON.parse(TEXT));
  if (parsed.kind !== "run") throw new Error(parsed.kind);
  return parsed.intermediate;
};
const INTERMEDIATE = RUN();
const compile = (calibration: readonly CalibrationReference[] = []) => {
  const r = compileRoomShell(INTERMEDIATE, { calibration });
  if (!r.ok) throw new Error(r.problem.code);
  return r;
};
const plane = (id: string) => INTERMEDIATE.world.planes.find((p) => p.id === id)!;

/** A label map with given planes painted over their pixel boxes, the size of the canonical image. */
function labelMap(...ids: string[]): PlaneLabelMap {
  const { width, height } = INTERMEDIATE.source;
  const data = new Uint8Array(width * height);
  for (const id of ids) {
    const p = plane(id);
    const [x0, y0, x1, y1] = p.pixelBox;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * width + x] = p.label;
  }
  return { width, height, data };
}

// Two points on the floor (plane-0), inside its fitted region.
const A = [700.5, 1000.5] as const;
const B = [900.5, 1000.5] as const;

describe("8C — the degraded state, explained from the worker's own diagnostics", () => {
  it("says the camera calibration is estimated, with the two models' numbers, and offers calibration", () => {
    const e = explainRun(INTERMEDIATE.diagnostics, "estimated");
    expect(e.status).toBe("degraded");
    expect(e.headline).toBe("Reconstruction completed with estimated camera calibration.");
    expect(e.reasons).toHaveLength(1);
    expect(e.reasons[0].code).toBe("fov-disagreement");
    expect(e.reasons[0].text).toBe(
      "GeoCalib's field of view (54.0°) and MoGe-2's (59.1°) disagree by 5.2°, more than the worker accepts, so the camera calibration is an estimate.",
    );
    expect(e.action).toEqual({ kind: "calibrate", label: "Calibrate a known distance" });
    expect(e.calibrated).toBeNull();
  });

  it("after calibration, claims the scale and no more: the field of view is still estimated", () => {
    const e = explainRun(INTERMEDIATE.diagnostics, "calibrated");
    expect(e.status).toBe("degraded");
    expect(e.action).toBeNull();
    expect(e.calibrated).toMatch(/fixes the room's size, not its proportions/);
  });

  it("tells a clean run, a failed run and an unknown warning plainly", () => {
    expect(explainRun({ status: "succeeded", warnings: [], errors: [] }, "estimated")).toMatchObject({ headline: "Reconstruction completed.", reasons: [] });
    const failed = explainRun({ status: "failed", warnings: [], errors: [{ code: "no-floor", stage: "layout", severity: "error", message: "no floor plane was found" }] }, "estimated");
    expect(failed).toMatchObject({ headline: "The reconstruction failed.", action: null, reasons: [{ text: "No floor plane was found." }] });
    const other = explainRun({ status: "degraded", warnings: [{ code: "x", stage: "objects", severity: "warning", message: "something odd" }], errors: [] }, "estimated");
    expect(other.headline).toBe("Reconstruction completed with warnings.");
  });
});

describe("8A — evidence and provenance", () => {
  const r = compile();
  const groups = roomEvidence({ scene: r.scene, evidence: r.evidence, report: r.report, intermediate: INTERMEDIATE });
  const group = (title: string) => groups.find((g) => g.title === title)!;
  const rowOf = (title: string, label: string) => group(title).rows.find((x) => x.label === label)!;

  it("lays out room, camera, planes, depth and scale, materials and lighting", () => {
    expect(groups.map((g) => g.title)).toEqual(["Room", "Camera", "Planes", "Depth and scale", "Materials", "Lighting"]);
  });

  it("keeps each value's recorded basis and sources, including an unseen side's default", () => {
    expect(rowOf("Room", "Width")).toMatchObject({ value: "3.72 m", basis: "estimated" });
    expect(rowOf("Room", "Depth")).toMatchObject({ basis: "default" });
    expect(rowOf("Room", "Height").sources).toContain("fitted plane plane-1");
    expect(rowOf("Camera", "Field of view")).toMatchObject({ value: "59.1° vertical", basis: "estimated", sources: ["MoGe-2 depth and geometry"] });
    expect(rowOf("Camera", "Field of view").note).toMatch(/GeoCalib's own vFOV sigma 6.54 deg > 5.0 deg/);
    expect(rowOf("Camera", "Principal point")).toMatchObject({ basis: "default" });
    expect(group("Planes").rows).toHaveLength(18);
    expect(rowOf("Depth and scale", "Scale")).toMatchObject({ basis: "estimated", value: "the depth model's metric estimate" });
  });

  it("invents no confidence: nothing the compiler did not record is shown as a probability", () => {
    const text = JSON.stringify(groups);
    expect(text).not.toMatch(/confidence|probability \d|\d+% (sure|confident|likely)/i);
    expect(readSource("grounding-dino-base@12bdfa3")).toBe("Grounding DINO detection");
    expect(readSource("plane:plane-3")).toBe("fitted plane plane-3");
    expect(readSource("rule:object-rules-0.1")).toBe("rule object-rules-0.1");
  });

  it("gives a piece its detection, mask, depth, placement, scale and representation", () => {
    const sofa = r.scene.objects.find((o) => o.id === "sofa-0")!;
    const g = objectEvidence(sofa, { evidence: r.evidence, intermediate: INTERMEDIATE })!;
    const by = Object.fromEntries(g.rows.map((x) => [x.label, x]));
    expect(Object.keys(by)).toEqual(["Detection", "Mask", "Depth", "Placement", "Turn", "Stands on", "Size", "Scale", "Drawn as"]);
    expect(by.Detection).toMatchObject({ basis: "estimated", sources: ["Grounding DINO detection"] });
    expect(by.Detection.value).toMatch(/raw score 0.695/);
    expect(by.Detection.note).toMatch(/not a probability/);
    expect(by.Mask.value).toMatch(/^instance-1, mask score 0\.\d\d \(raw\)$/);
    expect(by.Depth.sources).toEqual(["MoGe-2 depth and geometry"]);
    expect(by.Turn).toMatchObject({ basis: "inferred" });
    expect(by.Size).toMatchObject({ basis: "estimated", value: "from what was seen" });
    expect(by.Scale).toMatchObject({ basis: "estimated" });
    expect(by["Drawn as"]).toMatchObject({ value: "a parametric sofa, track arm form", basis: "default" });
    expect(g.notes.join(" ")).toMatch(/Also read as bed \(raw score 0.28\)/);
  });

  it("says when a piece's size is a category's typical one", () => {
    const arm = r.scene.objects.find((o) => o.label === "Armchair 1")!;
    const by = Object.fromEntries(objectEvidence(arm, { evidence: r.evidence, intermediate: INTERMEDIATE })!.rows.map((x) => [x.label, x]));
    expect(by.Size).toMatchObject({ basis: "inferred", value: "the category's typical size" });
  });

  it("has nothing to say for a piece that is not the one in the photograph", () => {
    const added = { ...r.scene.objects[0], id: "added-1" };
    expect(objectEvidence(added, { evidence: r.evidence, intermediate: INTERMEDIATE })).toBeNull();
  });
});

describe("8B — calibration from marks on the photograph", () => {
  it("resolves a pixel to the plane the worker fitted there, and nothing where none was", () => {
    const map = labelMap("plane-0");
    expect(planeAt(INTERMEDIATE, map, A)?.id).toBe("plane-0");
    expect(planeAt(INTERMEDIATE, map, [10, 10])).toBeNull();
    expect(planeAt(INTERMEDIATE, map, [-1, 5])).toBeNull();
    expect(planeName(plane("plane-0"), compile().report)).toBe("the floor");
    expect(planeName(plane("plane-2"), compile().report)).toMatch(/^the (left|right|far) wall$/);
  });

  it("measures two marks on one plane exactly as the compiler's estimateOf does", () => {
    const m = measureMarks(INTERMEDIATE, labelMap("plane-0"), A, B);
    if (!m.ok) throw new Error(m.reason);
    expect(m.plane.id).toBe("plane-0");
    expect(m.estimate).toBe(estimateOf(INTERMEDIATE, { kind: "on-plane", planeId: "plane-0", a: A, b: B, metres: 1 }));
    expect(m.estimate).toBeGreaterThan(0.1);
  });

  it("refuses marks off every plane, on two planes, or against a map for another image", () => {
    const map = labelMap("plane-0", "plane-2");
    expect(measureMarks(INTERMEDIATE, map, A, [10, 10])).toMatchObject({ ok: false, reason: expect.stringMatching(/surface the reconstruction fitted/) });
    expect(measureMarks(INTERMEDIATE, map, A, [100, 300])).toMatchObject({ ok: false, reason: expect.stringMatching(/same surface/) });
    expect(measureMarks(INTERMEDIATE, { width: 10, height: 10, data: new Uint8Array(100) }, A, B)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match/) });
  });

  it("previews the factor exactly as the compiler will apply it", () => {
    const m = measureMarks(INTERMEDIATE, labelMap("plane-0"), A, B);
    if (!m.ok) throw new Error(m.reason);
    const ref: CalibrationReference = { kind: "on-plane", planeId: "plane-0", a: A, b: B, metres: 1 };
    const p = previewCalibration(INTERMEDIATE, [ref]);
    expect(p.solution.factor).toBeCloseTo(1 / m.estimate, 12);
    expect(compile([ref]).evidence.scale.factor).toBeCloseTo(p.solution.factor, 5);
    expect(p.changePercent).toBeCloseTo((p.solution.factor - 1) * 100, 12);
  });

  it("reports references that disagree by more than the compiler's 5%", () => {
    const h = estimateOf(INTERMEDIATE, { kind: "room-height", metres: 1 }) as number;
    const agree = previewCalibration(INTERMEDIATE, [roomHeightReference(h * 1.1), roomHeightReference(h * 1.12)]);
    const disagree = previewCalibration(INTERMEDIATE, [roomHeightReference(h), roomHeightReference(h * 1.3)]);
    expect(agree.disagree).toBe(false);
    expect(disagree.disagree).toBe(true);
    expect(compile(disagree.solution.accepted.map((a) => a.reference)).report.problems.map((p) => p.code)).toContain("calibration-references-disagree");
  });
});

describe("8B — calibrating the room: one factor on the shared frame", () => {
  const before = compile();
  const reference = roomHeightReference(2.7, "room height");
  const after = compile([reference]);
  const factor = after.evidence.scale.factor;

  it("rescales every length read from the photo by the one factor, and keeps every id", () => {
    expect(factor).toBeCloseTo(2.7 / 2.998, 3);
    expect(after.scene.id).toBe(before.scene.id);
    expect(after.scene.objects.map((o) => o.id)).toEqual(before.scene.objects.map((o) => o.id));
    // The room's observed extents are exactly the one factor: the shared frame, not piece by piece.
    // (Its depth here is a stated default — a side was not seen — and a default is not the photo's to scale.)
    after.scene.room.footprint.forEach((p, i) => expect(p[0]).toBeCloseTo(before.scene.room.footprint[i][0] * factor, 2));
    expect(after.scene.room.height).toBeCloseTo(before.scene.room.height * factor, 2);
    let scaled = 0;
    let typical = 0;
    for (const [i, o] of after.scene.objects.entries()) {
      const b = before.scene.objects[i];
      // Placement rules act in real metres (snapping to a wall within 0.35 m, a typical depth against it),
      // so a piece lands near its scaled position, not exactly on it.
      o.transform.position.forEach((v, k) => expect(Math.abs(v - b.transform.position[k] * factor), `${o.id} position ${k}`).toBeLessThan(0.1));
      expect(o.transform.rotation[1]).toBeCloseTo(b.transform.rotation[1], 6);
      o.dimensions.forEach((d, k) => {
        const basis = before.evidence.entities[o.id]?.fields[`dimensions.${k}`]?.basis;
        // A size read from the photo shares the photo's scale; a category's typical size is already a real one.
        if (basis === "estimated") {
          const now = after.evidence.entities[o.id].fields[`dimensions.${k}`];
          if (now.basis === "calibrated") {
            expect(d, `${o.id} dimension ${k}`).toBeCloseTo(b.dimensions[k] * factor, 2);
            scaled++;
          } else {
            // Scaled below what such a piece can be, the compiler falls back to its typical size, and says so.
            expect(now.basis, `${o.id} dimension ${k}`).toBe("inferred");
            expect(after.evidence.entities[o.id].notes.join(" "), o.id).toMatch(/typical/);
          }
        } else if (basis === "inferred" || basis === "default") {
          typical++;
        }
      });
    }
    expect(scaled).toBeGreaterThan(20);
    expect(typical).toBeGreaterThan(0);
  });

  it("turns estimated evidence calibrated, and leaves inferred and default as they were", () => {
    expect(after.evidence.entities.room.fields.width.basis).toBe("calibrated");
    expect(after.evidence.entities.room.fields.depth.basis).toBe("default");
    expect(after.evidence.entities["sofa-0"].fields["dimensions.0"].basis).toBe("calibrated");
    const typicalAxes = Object.entries(before.evidence.entities).flatMap(([id, e]) =>
      e.kind === "object" ? [0, 1, 2].filter((k) => e.fields[`dimensions.${k}`]?.basis === "inferred").map((k) => [id, k] as const) : [],
    );
    expect(typicalAxes.length).toBeGreaterThan(0);
    for (const [id, k] of typicalAxes) expect(after.evidence.entities[id].fields[`dimensions.${k}`].basis).toBe("inferred");
    const by = Object.fromEntries(objectEvidence(after.scene.objects.find((o) => o.id === "sofa-0")!, { evidence: after.evidence, intermediate: INTERMEDIATE })!.rows.map((x) => [x.label, x]));
    expect(by.Scale).toMatchObject({ basis: "calibrated", sources: ["your calibration"] });
    expect(by.Size.basis).toBe("calibrated");
  });

  it("updates measurements: values scale, and are shown to the calibrated step", () => {
    const m0 = measureScene(before.scene, before.evidence);
    const m1 = measureScene(after.scene, after.evidence);
    if (!m0.room.width.available || !m1.room.width.available || !m1.room.height.available) throw new Error("unavailable");
    expect(m1.room.width.value).toBeCloseTo(m0.room.width.value * factor, 2);
    expect(m1.room.height.value).toBeCloseTo(2.7, 2);
    expect(m0.room.width).toMatchObject({ basis: "estimated", resolution: 0.1 });
    expect(m1.room.width).toMatchObject({ basis: "calibrated", resolution: 0.01 });
    expect(m1.room.width.sigma).toBeNull();
    if (!m0.floor.free.available || !m1.floor.free.available) throw new Error("unavailable");
    expect(m1.floor.free.value).toBeCloseTo(m0.floor.free.value * factor * factor, 0);
  });

  it("updates spatial analysis and layouts: a 60 cm path is 60 real centimetres", () => {
    const c0 = circulationOf(before.scene).walkableArea;
    const c1 = circulationOf(after.scene).walkableArea;
    expect(c1).toBeLessThan(c0 * factor * factor);
    const intent = validateDesignIntent(readBrief("Give me three furniture layouts."));
    if (!intent.ok) throw new Error(intent.reason);
    const layouts = (scene: Scene) => {
      const r = generateProposals(scene, intent.intent);
      if (!r.ok) throw new Error(r.reason);
      return r.proposals;
    };
    const l0 = layouts(before.scene);
    const l1 = layouts(after.scene);
    expect(l1.length).toBeGreaterThan(0);
    expect(JSON.stringify(l1.map((p) => p.operations))).not.toBe(JSON.stringify(l0.map((p) => p.operations)));
  });

  it("removing the calibration gives back the estimated room exactly", () => {
    const state = { status: "compiled", intermediate: INTERMEDIATE, calibration: [reference], calibrationProblem: null, result: after } as Extract<RunState, { status: "compiled" }>;
    const removed = recompile(state, []);
    if (!removed.result.ok) throw new Error("not compiled");
    expect(JSON.stringify(removed.result.scene)).toBe(JSON.stringify(before.scene));
    expect(JSON.stringify(removed.result.evidence)).toBe(JSON.stringify(before.evidence));
    const again = recompile(removed, [reference]);
    if (!again.result.ok) throw new Error("not compiled");
    expect(JSON.stringify(again.result.scene)).toBe(JSON.stringify(after.scene));
  });

  it("is not an edit: a calibrated room opens with an empty history, and undo cannot reach back past it", () => {
    const store = new WorkspaceStore(after.scene, "Room", notConnected, after.scene.materials);
    expect(store.getState().doc.past).toHaveLength(0);
    store.undo();
    expect(JSON.stringify(store.getState().doc.scene)).toBe(JSON.stringify(after.scene));
  });
});

describe("8B — calibration persistence", () => {
  let dir: string;
  const RUN_ID = "20260922T065240Z-2d25a689";
  const run = () => join(dir, RUN_ID);
  const put = (references: unknown, runId = RUN_ID) => saveCalibration(runId, { schemaVersion: 1, references }, dir);
  const onFloor = (metres: number) => ({ kind: "on-plane", planeId: "plane-0", a: A, b: B, metres, label: "tile row" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "datum-cal-"));
    mkdirSync(run());
    writeFileSync(join(run(), "reconstruction.json"), TEXT);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes calibration.json in the compiler's schema, which loads back to the same factor", async () => {
    const response = await put([onFloor(1.2)]);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.basis).toBe("calibrated");
    const file = JSON.parse(readFileSync(join(run(), "calibration.json"), "utf8"));
    expect(file).toEqual({ schemaVersion: 1, references: [{ kind: "on-plane", planeId: "plane-0", a: [700.5, 1000.5], b: [900.5, 1000.5], metres: 1.2, label: "tile row" }] });
    expect(compile(file.references).evidence.scale.factor).toBeCloseTo(body.factor, 5);
  });

  it("never replaces a calibration silently: the previous file is kept, as the worker's CLI does", async () => {
    await put([onFloor(1.2)]);
    const first = readFileSync(join(run(), "calibration.json"), "utf8");
    await put([onFloor(1.2), { kind: "room-height", metres: 2.7 }]);
    expect(readFileSync(join(run(), "calibration.1.json"), "utf8")).toBe(first);
    const removed = await put([]);
    expect(removed.status).toBe(200);
    expect(existsSync(join(run(), "calibration.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(run(), "calibration.2.json"), "utf8")).references).toHaveLength(2);
  });

  it("refuses invalid input and writes nothing", async () => {
    const cases: [Promise<Response>, number, string][] = [
      [saveCalibration(RUN_ID, { schemaVersion: 2, references: [] }, dir), 400, "invalid-calibration"],
      [saveCalibration(RUN_ID, "nonsense", dir), 400, "invalid-calibration"],
      [put([{ kind: "on-plane", planeId: "plane-0", a: [1], b: B, metres: 1 }]), 400, "invalid-calibration"],
      [put([onFloor(0.01)]), 422, "reference-rejected"],
      [put([onFloor(Number.NaN)]), 422, "reference-rejected"],
      [put([{ ...onFloor(1), planeId: "plane-99" }]), 422, "reference-rejected"],
      [put([onFloor(1)], "../escape"), 404, "not-found"],
      [put([onFloor(1)], "no-such-run"), 404, "not-found"],
    ];
    for (const [pending, status, code] of cases) {
      const response = await pending;
      expect([response.status, (await response.json()).code]).toEqual([status, code]);
    }
    expect(existsSync(join(run(), "calibration.json"))).toBe(false);
    expect((await saveCalibration(RUN_ID, { schemaVersion: 1, references: [] }, "")).status).toBe(404);
  });

  it("writes only the schema's fields", async () => {
    await put([{ ...onFloor(1), extra: "field", note: "<script>" }]);
    const file = JSON.parse(readFileSync(join(run(), "calibration.json"), "utf8"));
    expect(Object.keys(file.references[0]).sort()).toEqual(["a", "b", "kind", "label", "metres", "planeId"]);
  });
});
