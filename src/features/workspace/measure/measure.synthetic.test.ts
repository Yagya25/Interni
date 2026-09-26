import { describe, expect, it } from "vitest";
import { livingRoom } from "@/demo/livingRoom";
import type { CalibrationReference } from "@/scene/compile/calibration";
import { compileRoomShell } from "@/scene/compile/compileRoomShell";
import type { EntityEvidence, SceneEvidence } from "@/scene/compile/evidence";
import type { Basis, Quantity } from "@/scene/compile/intermediate";
import { DEFAULT_ROOM, project, syntheticInstances, syntheticIntermediate, truePoint } from "@/scene/compile/__fixtures__/synthetic";
import { applyOperations } from "@/scene/model/operations";
import type { Id, ObjectCategory, Opening, Scene, SceneObject, Vec2, WallSurface } from "@/scene/model/types";
import { footprintOf, separation } from "../ai/rules/spatial";
import { circulationOf } from "../design/layout/circulation";
import {
  answer,
  atLeast,
  basisOf,
  clearAround,
  computeMeasurements,
  distanceBetween,
  formatMeasurement,
  formatSeries,
  knowledgeOf,
  measureScene,
  walkwayTo,
  type Measured,
  type Measurement,
} from "./index";
import { rounding, roundTo } from "./types";

/**
 * The measurement engine on rooms whose every answer is known exactly:
 * hand-built Scenes, a few boxes in a rectangle, so each expectation is
 * arithmetic, not a reading of the engine's own output.
 */

// ---------------------------------------------------------------------------
// Scaffolding

const RAD = Math.PI / 180;

/** A rectangular room, `width` across (X) by `depth` along (Z), centred on the origin, walls on all four sides. */
function room(width: number, depth: number, objects: SceneObject[] = [], openings: Opening[] = [], height = 2.5): Scene {
  const x = width / 2;
  const z = depth / 2;
  const wall = (id: Id, label: string, start: Vec2, end: Vec2): WallSurface => ({ id, kind: "wall", label, materialId: "m", evidence: "observed", start, end, thickness: 0.1 });
  return {
    schemaVersion: 1,
    id: "synthetic",
    provenance: { kind: "reconstruction", sourceImageId: "photo", pipelineVersion: "test", createdAt: "2026-01-01T00:00:00Z" },
    room: { type: "other", label: "Synthetic room", footprint: [[-x, -z], [x, -z], [x, z], [-x, z]], height },
    camera: { position: [0, 1.5, z - 0.5], target: [0, 1, 0], verticalFov: 50, aspect: 1.5 },
    surfaces: [
      { id: "floor", kind: "floor", label: "Floor", materialId: "m", evidence: "observed" },
      { id: "ceiling", kind: "ceiling", label: "Ceiling", materialId: "m", evidence: "observed" },
      wall("wall-far", "Far wall", [-x, -z], [x, -z]),
      wall("wall-right", "Right wall", [x, -z], [x, z]),
      wall("wall-near", "Near wall", [x, z], [-x, z]),
      wall("wall-left", "Left wall", [-x, z], [-x, -z]),
    ],
    openings,
    objects,
    materials: [],
    lights: [],
    relationships: [],
  };
}

/** A piece standing on the floor at (x, z), `w` wide, `h` high, `d` deep, turned by `deg`. */
function piece(id: Id, category: ObjectCategory, at: Vec2, [w, h, d]: [number, number, number], deg = 0, scale: [number, number, number] = [1, 1, 1]): SceneObject {
  return {
    id,
    category,
    label: id,
    transform: { position: [at[0], 0, at[1]], rotation: [0, deg * RAD, 0], scale },
    dimensions: [w, h, d],
    materials: {},
    support: { kind: "floor" },
  };
}

/** A doorway in the far wall, its centre `offset` from the wall's start. */
const door = (width: number, offset: number): Opening => ({ id: "door-0", kind: "door", label: "Door", wallId: "wall-far", offset, width, height: 2.1, sill: 0, frameMaterialId: "m", panelMaterialId: "m" });

const q = (value: unknown, basis: Basis, note?: string, sigma: number | null = null): Quantity<unknown> => ({ value, basis, sigma, interval: null, confidence: null, sources: ["synthetic"], ...(note ? { note } : {}) });

/** Evidence as the compiler writes it, for a synthetic scene: `bases` sets a piece's width, depth and height bases. */
function evidenceFor(scene: Scene, bases: Record<Id, [Basis, Basis, Basis]> = {}, roomBases: [Basis, Basis, Basis] = ["estimated", "estimated", "estimated"], roomHeightSigma: number | null = null): SceneEvidence {
  const [x0, x1] = [Math.min(...scene.room.footprint.map((p) => p[0])), Math.max(...scene.room.footprint.map((p) => p[0]))];
  const [z0, z1] = [Math.min(...scene.room.footprint.map((p) => p[1])), Math.max(...scene.room.footprint.map((p) => p[1]))];
  const entities: Record<Id, EntityEvidence> = {
    room: { kind: "room", presence: { basis: "estimated" }, fields: { width: q(x1 - x0, roomBases[0]), depth: q(z1 - z0, roomBases[1]), height: q(scene.room.height, roomBases[2], undefined, roomHeightSigma) }, observations: [], notes: [] },
  };
  for (const s of scene.surfaces) if (s.kind === "wall") entities[s.id] = { kind: "surface", presence: { basis: "estimated" }, fields: { position: q(0, "estimated") }, observations: [], notes: [] };
  for (const o of scene.openings) entities[o.id] = { kind: "opening", presence: { basis: "estimated" }, fields: { width: q(o.width, "estimated"), height: q(o.height, "estimated"), sill: q(o.sill, "estimated") }, observations: [], notes: [] };
  for (const o of scene.objects) {
    const [bw, bd, bh] = bases[o.id] ?? ["estimated", "estimated", "estimated"];
    entities[o.id] = {
      kind: "object",
      presence: { basis: "estimated" },
      fields: {
        category: q(o.category, "estimated"),
        "dimensions.0": q(o.dimensions[0], bw, "width, from the visible points (a lower bound)"),
        "dimensions.1": q(o.dimensions[1], bh, "height"),
        "dimensions.2": q(o.dimensions[2], bd, "depth"),
        "transform.position": q(o.transform.position, "estimated"),
        "transform.rotation.1": q(Math.round((o.transform.rotation[1] / RAD) * 100) / 100, "inferred", "degrees"),
        support: q("floor", "estimated"),
      },
      observations: [],
      notes: [],
    };
  }
  return { schemaVersion: 1, sceneId: scene.id, scale: { factor: 1, basis: "estimated", logSigma: null, references: [], residuals: [] }, entities };
}

function got(m: Measured): Measurement {
  if (!m.available) throw new Error(`unavailable: ${m.reason}`);
  return m;
}

const objectOf = (scene: Scene, evidence: SceneEvidence | null, id: Id) => measureScene(scene, evidence).objects.find((o) => o.id === id)!;

// ---------------------------------------------------------------------------

describe("the room", () => {
  it("derives width, depth, height, floor area and perimeter from the footprint", () => {
    const scene = room(4, 5, [], [], 2.6);
    const r = computeMeasurements(scene, evidenceFor(scene)).room;
    expect(got(r.width).value).toBeCloseTo(4, 12);
    expect(got(r.depth).value).toBeCloseTo(5, 12);
    expect(got(r.height).value).toBeCloseTo(2.6, 12);
    expect(got(r.floorArea).value).toBeCloseTo(20, 12);
    expect(got(r.perimeter).value).toBeCloseTo(18, 12);
    expect(got(r.floorArea).unit).toBe("m²");
  });

  it("reads each dimension's basis from the evidence, and an unseen side as a lower bound", () => {
    const scene = room(4, 5);
    const r = computeMeasurements(scene, evidenceFor(scene, {}, ["estimated", "inferred", "default"])).room;
    expect(got(r.width)).toMatchObject({ basis: "estimated", bound: "value" });
    // The compiler closes an unseen side at the farthest point seen: the room is at least that deep.
    expect(got(r.depth)).toMatchObject({ basis: "inferred", bound: "at-least" });
    expect(got(r.height)).toMatchObject({ basis: "default", bound: "value" });
    // The floor is only as well known as its weakest side, and claims no bound with a default in it.
    expect(got(r.floorArea).basis).toBe("inferred");
    expect(got(r.floorArea).bound).toBe("at-least");
  });
});

describe("a piece", () => {
  it("has its scale applied to its size, and its turn to its plan extent", () => {
    const scene = room(6, 6, [piece("sofa", "sofa", [0, 0], [2, 0.8, 0.9], 30, [1.5, 1, 1])]);
    const o = objectOf(scene, evidenceFor(scene), "sofa");
    expect(got(o.size.width).value).toBeCloseTo(3, 12);
    expect(got(o.size.depth).value).toBeCloseTo(0.9, 12);
    expect(got(o.size.height).value).toBeCloseTo(0.8, 12);
    const c = Math.cos(30 * RAD);
    const s = Math.sin(30 * RAD);
    expect(got(o.bounds.across).value).toBeCloseTo(3 * c + 0.9 * s, 9);
    expect(got(o.bounds.along).value).toBeCloseTo(3 * s + 0.9 * c, 9);
    expect(got(o.footprint!.area).value).toBeCloseTo(2.7, 9);
    expect(got(o.bounds.top).value).toBeCloseTo(0.8, 12);
    expect(o.onFloor.value).toBe(true);
  });

  it("measures the true distance between two pieces, corner to corner too", () => {
    const scene = room(8, 8, [piece("a", "cabinet", [0, 0], [1, 1, 1]), piece("b", "cabinet", [1.5, 0], [1, 1, 1]), piece("c", "cabinet", [2, 2], [1, 1, 1])]);
    const k = knowledgeOf(scene, evidenceFor(scene));
    expect(got(distanceBetween(k, "a", "b")).value).toBeCloseTo(0.5, 12);
    // Diagonally apart by 1 m in x and in z: √2 apart, where a separating-axis gap reads only 1.
    expect(got(distanceBetween(k, "a", "c")).value).toBeCloseTo(Math.SQRT2, 9);
    expect(separation(footprintOf(scene.objects[0]), footprintOf(scene.objects[2]))).toBeCloseTo(1, 9);
    expect(objectOf(scene, k.evidence, "a").nearest).toMatchObject({ id: "b" });
    expect(got(objectOf(scene, k.evidence, "a").nearest!.distance).value).toBeCloseTo(0.5, 12);
    // Overlapping pieces are 0 apart.
    const over = room(8, 8, [piece("a", "cabinet", [0, 0], [1, 1, 1]), piece("b", "cabinet", [0.5, 0], [1, 1, 1])]);
    expect(got(distanceBetween(knowledgeOf(over, null), "a", "b")).value).toBe(0);
  });

  it("measures its gap to the nearest wall, and tells touching from standing off", () => {
    const scene = room(4, 5, [piece("off", "cabinet", [2 - 0.5 - 0.3, 0], [1, 1, 1]), piece("snug", "cabinet", [-2 + 0.25 + 0.01, 1], [0.5, 1, 0.5])]);
    const e = evidenceFor(scene);
    const off = objectOf(scene, e, "off").wall!;
    expect(off.wallId).toBe("wall-right");
    expect(got(off.gap).value).toBeCloseTo(0.3, 12);
    expect(off.touching).toBe(false);
    const snug = objectOf(scene, e, "snug").wall!;
    expect(snug.wallId).toBe("wall-left");
    // 1 cm is finer than an estimated gap is known (5 cm): it cannot be told from touching.
    expect(got(snug.gap).value).toBeCloseTo(0.01, 12);
    expect(snug.touching).toBe(true);
    expect(formatMeasurement(snug.gap)).toBe("< 0.05 m");
  });

  it("measures the clear floor in front of a seat up to the table, and around a piece on every side", () => {
    // Sofa facing +Z (towards the near wall), its front face at z = −0.55; the table's near edge at z = −0.3.
    const scene = room(4, 5, [piece("sofa", "sofa", [0, -1], [2, 0.8, 0.9]), piece("table", "coffee-table", [0, 0], [1, 0.4, 0.6])]);
    const e = evidenceFor(scene);
    const front = objectOf(scene, e, "sofa").front!;
    expect(got(front.depth).value).toBeCloseTo(0.25, 12);
    expect(front.endedBy).toMatchObject({ kind: "object", id: "table" });
    // A table that has no front has no "in front" reading.
    expect(objectOf(scene, e, "table").front).toBeNull();
    const around = clearAround(knowledgeOf(scene, e), scene.objects[0])!;
    expect(got(around.back.depth).value).toBeCloseTo(-1 - 0.45 + 2.5, 12);
    expect(around.back.endedBy).toMatchObject({ kind: "wall", id: "wall-far" });
    expect(got(around["side-a"].depth).value).toBeCloseTo(1, 12);
    expect(got(around["side-b"].depth).value).toBeCloseTo(1, 12);
    // Moved aside, the table no longer ends the sofa's legroom: the near wall does.
    const aside = applyOperations(scene, [{ kind: "move", objectId: "table", to: [1.8, 0, 0], rotationY: 0 }]);
    const clear = objectOf(aside, e, "sofa").front!;
    expect(clear.endedBy).toMatchObject({ kind: "wall", id: "wall-near" });
    expect(got(clear.depth).value).toBeCloseTo(2.5 + 0.55, 12);
  });
});

describe("a doorway", () => {
  it("measures clear depth straight in from it, and what stands in its clear zone", () => {
    const scene = room(4, 5, [piece("box", "cabinet", [0, -2.5 + 1.2 + 0.25], [1, 1, 0.5])], [door(0.9, 2)]);
    const e = evidenceFor(scene);
    const o = computeMeasurements(scene, e).openings[0];
    expect(o.passage).toBe(true);
    expect(got(o.width).value).toBeCloseTo(0.9, 12);
    expect(got(o.clearDepth!.depth).value).toBeCloseTo(1.2, 12);
    expect(o.clearDepth!.endedBy).toMatchObject({ kind: "object", id: "box" });
    expect(o.intrusions).toEqual([]);
    // Brought 0.5 m from the wall, it stands 0.4 m into the 0.9 m zone.
    const close = applyOperations(scene, [{ kind: "move", objectId: "box", to: [0, 0, -2.5 + 0.5 + 0.25], rotationY: 0 }]);
    const c = computeMeasurements(close, e).openings[0];
    expect(c.intrusions.map((i) => i.id)).toEqual(["box"]);
    expect(got(c.intrusions[0].depth).value).toBeCloseTo(0.4, 9);
    // Moved clear to the side, the floor in front runs to the opposite wall.
    const aside = applyOperations(scene, [{ kind: "move", objectId: "box", to: [1.4, 0, 0], rotationY: 0 }]);
    const a = computeMeasurements(aside, e).openings[0];
    expect(a.clearDepth!.endedBy).toMatchObject({ kind: "wall", id: "wall-near" });
    expect(got(a.clearDepth!.depth).value).toBeCloseTo(5, 12);
  });
});

describe("walkways", () => {
  // A barrier across the room with an 0.80 m gap, the doorway on one side, the sofa on the other.
  const barrier = () =>
    room(4, 5, [piece("left", "cabinet", [-1.2, 0], [1.6, 1, 0.4]), piece("right", "cabinet", [1.2, 0], [1.6, 1, 0.4]), piece("sofa", "sofa", [0, 2.5 - 0.45], [2, 0.8, 0.9], 180)], [door(0.9, 2)]);

  it("finds the narrowest point on the widest way in, and what bounds it", () => {
    const scene = barrier();
    const way = walkwayTo(knowledgeOf(scene, evidenceFor(scene)), "sofa");
    if (!way.reachable) throw new Error(way.reason);
    expect(way.from).toBe("door-0");
    expect(got(way.width).value).toBeGreaterThan(0.8 - 0.05);
    expect(got(way.width).value).toBeLessThan(0.8 + 0.05);
    expect(way.between.map((b) => b.id).sort()).toEqual(["left", "right"]);
    expect(got(way.width).resolution).toBeGreaterThanOrEqual(0.05);
  });

  it("says whether there is at least a width, and says so only as far as it is known", () => {
    const scene = barrier();
    const e = evidenceFor(scene);
    const ask = (metres: number) => answer(scene, e, { kind: "circulation-at-least", metres });
    expect(ask(0.6)).toMatchObject({ ok: true, verdict: "yes" });
    expect(ask(1.0)).toMatchObject({ ok: true, verdict: "no" });
    // 0.80 m against 80 cm is within the 5 cm it is known to.
    expect(ask(0.8)).toMatchObject({ ok: true, verdict: "too-close-to-call" });
  });

  it("is the doorway itself when nothing in the room is narrower", () => {
    const scene = room(4, 5, [piece("sofa", "sofa", [0, 2.5 - 0.45], [2, 0.8, 0.9], 180)], [door(0.9, 2)]);
    const way = walkwayTo(knowledgeOf(scene, evidenceFor(scene)), "sofa");
    if (!way.reachable) throw new Error(way.reason);
    expect(way.atDoorway).toBe(true);
    expect(got(way.width).value).toBeCloseTo(0.9, 9);
  });

  it("says when a piece cannot be reached, or when there is no way in at all", () => {
    const shut = room(4, 5, [piece("wall-of-boxes", "cabinet", [0, 0], [4, 1, 0.4]), piece("sofa", "sofa", [0, 2.05], [2, 0.8, 0.9], 180)], [door(0.9, 2)]);
    expect(walkwayTo(knowledgeOf(shut, null), "sofa")).toMatchObject({ reachable: false });
    const doorless = room(4, 5, [piece("sofa", "sofa", [0, 2.05], [2, 0.8, 0.9], 180)]);
    expect(walkwayTo(knowledgeOf(doorless, null), "sofa")).toMatchObject({ reachable: false, reason: "the room has no doorway to walk in from" });
    expect(answer(doorless, null, { kind: "circulation-at-least", metres: 0.8 })).toMatchObject({ ok: false });
  });
});

describe("the floor: free floor and circulation are different measurements", () => {
  it("counts an empty room's whole floor as free, and reports the circulation heuristic unchanged", () => {
    const scene = room(4, 5, [], [door(0.9, 2)]);
    const f = computeMeasurements(scene, evidenceFor(scene)).floor;
    expect(got(f.free).value).toBeCloseTo(20, 12);
    expect(got(f.occupied).value).toBeCloseTo(0, 12);
    expect(got(f.circulation).value).toBe(circulationOf(scene).walkableArea);
    expect(got(f.circulation).value).toBeLessThan(got(f.free).value);
    expect(got(f.circulation).sources).toContain("rule:circulation-0.1");
  });

  it("counts overlapping pieces once, clips them to the room, and walks over a rug", () => {
    const scene = room(4, 5, [
      piece("a", "cabinet", [0, 0], [1, 1, 1]),
      piece("b", "cabinet", [0.5, 0], [1, 1, 1]),
      // Half outside the room: only its inside half takes floor.
      piece("c", "cabinet", [2, 1.5], [1, 1, 1]),
      piece("rug", "rug", [0, -1.5], [2, 0.01, 1.4]),
    ]);
    const f = computeMeasurements(scene, evidenceFor(scene)).floor;
    expect(got(f.occupied).value).toBeCloseTo(1.5 + 0.5, 9);
    expect(got(f.free).value).toBeCloseTo(20 - 2, 9);
    expect(got(f.free).value + got(f.occupied).value).toBeCloseTo(got(f.area).value, 12);
  });

  it("counts a turned piece's own footprint, not its bounding box", () => {
    const scene = room(6, 6, [piece("turned", "cabinet", [0, 0], [2, 1, 1], 45)]);
    expect(got(computeMeasurements(scene, null).floor.occupied).value).toBeCloseTo(2, 9);
  });
});

describe("provenance", () => {
  it("gives a derived measurement the weakest basis of what it was derived from", () => {
    const scene = room(4, 5, [piece("sofa", "sofa", [0, -1], [2, 0.8, 0.9]), piece("table", "coffee-table", [0, 0], [1, 0.4, 0.6])]);
    const e = evidenceFor(scene, { table: ["estimated", "inferred", "estimated"] });
    const k = knowledgeOf(scene, e);
    const gap = got(distanceBetween(k, "sofa", "table"));
    expect(gap.basis).toBe("inferred");
    expect(gap.inputs.some((i) => i.id === "table" && i.field === "dimensions.2" && i.basis === "inferred")).toBe(true);
    expect(gap.sources).toContain("rule:plan-distance");
    const sofaOnly = got(objectOf(scene, e, "sofa").size.width);
    expect(sofaOnly.basis).toBe("estimated");
  });

  it("carries a lower bound and a typical size through, from the evidence alone", () => {
    const scene = room(4, 5, [piece("sofa", "sofa", [0, -1], [2, 0.8, 0.9]), piece("chair", "armchair", [1, 1], [0.85, 0.85, 0.85])]);
    const e = evidenceFor(scene, { chair: ["inferred", "inferred", "inferred"] });
    const sofa = objectOf(scene, e, "sofa");
    expect(got(sofa.size.width).bound).toBe("at-least");
    expect(got(sofa.size.depth).bound).toBe("value");
    // Area grows with its sides: at least as large as a lower-bound width makes it.
    expect(got(sofa.footprint!.area).bound).toBe("at-least");
    const chair = objectOf(scene, e, "chair");
    expect(got(chair.size.width)).toMatchObject({ basis: "inferred", bound: "typical" });
    expect(formatMeasurement(chair.size.width)).toBe("typical ≈ 0.9 m");
    // A typical size never makes a bound claim on what it feeds.
    expect(got(chair.footprint!.area).bound).toBe("value");
  });

  it("marks what an edit touched as describing the design, and nothing else", () => {
    const scene = room(4, 5, [piece("sofa", "sofa", [0, -1], [2, 0.8, 0.9]), piece("table", "coffee-table", [0, 0], [1, 0.4, 0.6]), piece("lamp", "floor-lamp", [1.5, 2], [0.4, 1.6, 0.4])]);
    const e = evidenceFor(scene);
    const before = computeMeasurements(scene, e);
    expect(before.objects.every((o) => o.size.width.available && !o.size.width.edited)).toBe(true);
    const moved = applyOperations(scene, [{ kind: "move", objectId: "table", to: [0.3, 0, 0.2], rotationY: 0 }]);
    const k = knowledgeOf(moved, e);
    expect(got(distanceBetween(k, "sofa", "table")).edited).toBe(true);
    expect(basisOf(distanceBetween(k, "sofa", "table"))).toBe("estimated, as edited");
    expect(got(distanceBetween(k, "sofa", "lamp")).edited).toBe(false);
    // Moving a piece does not change what is known of its size.
    expect(got(objectOf(moved, e, "table").size.width).edited).toBe(false);
    // Resizing does, and the reconstructed lower bound no longer applies to the size set by hand.
    const resized = applyOperations(scene, [{ kind: "scale", objectId: "sofa", to: [1.2, 1, 1] }]);
    const w = got(objectOf(resized, e, "sofa").size.width);
    expect(w).toMatchObject({ edited: true, bound: "value" });
    expect(w.value).toBeCloseTo(2.4, 12);
    // A turned piece: its turn is now an input to its footprint.
    const turned = applyOperations(scene, [{ kind: "move", objectId: "sofa", to: [0, 0, -1], rotationY: 0.5 }]);
    expect(got(objectOf(turned, e, "sofa").footprint!.area).edited).toBe(false);
    expect(got(distanceBetween(knowledgeOf(turned, e), "sofa", "table")).inputs.some((i) => i.field === "transform.rotation.1" && i.edited)).toBe(true);
  });

  it("calls the demonstration room authored, and claims nothing measured of it", () => {
    const m = computeMeasurements(livingRoom);
    expect(m.source).toBe("authored");
    expect(m.scale).toBeNull();
    for (const x of [m.room.width, m.room.depth, m.floor.free, ...m.objects.flatMap((o) => [o.size.width, o.size.depth])]) {
      expect(got(x).basis).toBe("default");
      expect(basisOf(x)).toBe("authored, not measured");
    }
  });

  it("passes a σ through only from a value that carries one, and invents none", () => {
    const scene = room(4, 5, [piece("sofa", "sofa", [0, -1], [2, 0.8, 0.9])]);
    const m = computeMeasurements(scene, evidenceFor(scene, {}, ["estimated", "estimated", "estimated"], 0.05));
    expect(got(m.room.height).sigma).toBe(0.05);
    expect(got(m.room.floorArea).sigma).toBeNull();
    for (const x of [m.room.width, m.room.floorArea, m.floor.free, m.objects[0].size.width]) {
      expect(got(x)).toMatchObject({ interval: null, confidence: null });
    }
    expect(got(m.room.width).sigma).toBeNull();
  });

  it("ignores evidence that belongs to another Scene", () => {
    const scene = room(4, 5);
    const other = { ...evidenceFor(scene), sceneId: "someone-else" };
    expect(knowledgeOf(scene, other).evidence).toBeNull();
    expect(got(computeMeasurements(scene, other).room.width).basis).toBe("default");
  });
});

describe("calibrated against estimated, through the real compiler", () => {
  /** A 0.9 m span on the far wall, marked on the photo (as `compileRoomShell.test.ts` does). */
  const reference = (metres = 0.9, x = 0.2): CalibrationReference => {
    const z = DEFAULT_ROOM.box[2];
    return { kind: "on-plane", planeId: "plane-2", a: project(DEFAULT_ROOM, truePoint(DEFAULT_ROOM, [x, 1, z])), b: project(DEFAULT_ROOM, truePoint(DEFAULT_ROOM, [x + metres, 1, z])), metres };
  };
  const compiled = (calibration?: CalibrationReference[]) => {
    const r = compileRoomShell(syntheticIntermediate({}, syntheticInstances), { calibration });
    if (!r.ok) throw new Error(r.problem.code);
    return r;
  };

  it("flips estimated to calibrated, scales every length by the factor, and tightens the step", () => {
    const before = compiled();
    const after = compiled([reference()]);
    const a = computeMeasurements(before.scene, before.evidence);
    const b = computeMeasurements(after.scene, after.evidence);
    const factor = after.evidence.scale.factor;
    expect(factor).toBeCloseTo(1 / DEFAULT_ROOM.scaleError, 3);

    expect(got(a.room.height)).toMatchObject({ basis: "estimated", resolution: 0.1 });
    expect(got(b.room.height)).toMatchObject({ basis: "calibrated", resolution: 0.01 });
    expect(got(b.room.height).value).toBeCloseTo(got(a.room.height).value * factor, 2);
    expect(got(b.room.height).inputs.find((i) => i.id === "scale")).toMatchObject({ basis: "calibrated", sources: ["calibration:1 reference"] });

    const seen = a.objects.filter((o) => o.size.height.available && o.size.height.basis === "estimated");
    expect(seen.length).toBeGreaterThan(0);
    for (const o of seen) {
      const c = b.objects.find((x) => x.id === o.id)!;
      expect(got(c.size.height).basis).toBe("calibrated");
      expect(got(c.size.height).value).toBeCloseTo(got(o.size.height).value * factor, 2);
      expect(got(c.size.height).resolution).toBe(0.01);
    }
    // What was inferred stays inferred: calibration fixes the scale, not what was never seen.
    expect(got(b.room.width).basis).toBe(got(a.room.width).basis);
  });

  it("invents no uncertainty from calibration: σ stays null with several references", () => {
    const r = compiled([reference(0.9, 0.2), reference(0.6, -1.2)]);
    const m = computeMeasurements(r.scene, r.evidence);
    expect(r.evidence.scale.residuals.length).toBe(2);
    for (const x of [m.room.width, m.room.height, m.floor.free, ...m.objects.map((o) => o.size.width)]) {
      if (x.available) expect(x).toMatchObject({ sigma: null, interval: null, confidence: null });
    }
  });
});

describe("rounding and words", () => {
  it("rounds to a step chosen by basis, never finer", () => {
    expect(rounding(2.1374, "estimated", "m")).toEqual({ resolution: 0.1, rounded: 2.1 });
    expect(rounding(0.4637, "estimated", "m")).toEqual({ resolution: 0.05, rounded: 0.45 });
    expect(rounding(2.1374, "calibrated", "m")).toEqual({ resolution: 0.01, rounded: 2.14 });
    expect(rounding(0.85, "inferred", "m")).toEqual({ resolution: 0.1, rounded: 0.9 });
    // Rounds up across the 1 m band edge: shown at the coarser step it lands in.
    expect(rounding(0.98, "estimated", "m")).toEqual({ resolution: 0.1, rounded: 1 });
    expect(rounding(18.1689, "estimated", "m²")).toEqual({ resolution: 0.5, rounded: 18 });
    expect(rounding(18.1689, "calibrated", "m²")).toEqual({ resolution: 0.1, rounded: 18.2 });
    // A method's own step is a floor on it.
    expect(rounding(0.8123, "calibrated", "m", 0.05)).toEqual({ resolution: 0.05, rounded: 0.8 });
    expect(roundTo(0.85, 0.1)).toBe(0.9);
  });

  it("says ≈ for an estimate, nothing for a calibration, and at least / typical where they apply", () => {
    const scene = room(4, 5, [piece("sofa", "sofa", [0, -1], [2.1374, 0.8, 0.9]), piece("chair", "armchair", [1, 1], [0.85, 0.85, 0.85])]);
    const e = evidenceFor(scene, { chair: ["inferred", "inferred", "inferred"] });
    const sofa = objectOf(scene, e, "sofa");
    expect(formatMeasurement(sofa.size.width)).toBe("at least ≈ 2.1 m");
    expect(formatMeasurement(sofa.size.depth)).toBe("≈ 0.90 m");
    expect(formatSeries([sofa.size.width, sofa.size.depth, sofa.size.height])).toBe("≈ 2.1 × 0.90 × 0.80 m");
    expect(formatMeasurement(computeMeasurements(scene, e).floor.area)).toBe("≈ 20 m²");
    const calibrated = { ...e, scale: { ...e.scale, basis: "calibrated" as const } };
    for (const id of Object.keys(calibrated.entities)) {
      const ent = calibrated.entities[id];
      calibrated.entities = { ...calibrated.entities, [id]: { ...ent, fields: Object.fromEntries(Object.entries(ent.fields).map(([f, v]) => [f, v.basis === "estimated" ? { ...v, basis: "calibrated" as const } : v])) } };
    }
    expect(formatMeasurement(objectOf(scene, calibrated, "sofa").size.depth)).toBe("0.90 m");
  });

  it("calls a value within its own step of a threshold too close to call, and a lower bound below it never no", () => {
    const scene = room(4, 5, [piece("sofa", "sofa", [0, -1], [2, 0.8, 0.9])]);
    const e = evidenceFor(scene);
    const w = got(objectOf(scene, e, "sofa").size.width);
    expect(w.bound).toBe("at-least");
    expect(atLeast(w, 1.5)).toBe("yes");
    expect(atLeast(w, 2.05)).toBe("too-close-to-call");
    expect(atLeast(w, 3)).toBe("too-close-to-call");
    const d = got(objectOf(scene, e, "sofa").size.depth);
    expect(atLeast(d, 1.2)).toBe("no");
  });
});

describe("determinism and bad input", () => {
  it("gives the same answer every time, for the same Scene", () => {
    const build = () => room(4, 5, [piece("sofa", "sofa", [0, -1], [2, 0.8, 0.9], 12), piece("table", "coffee-table", [0.2, 0.1], [1, 0.4, 0.6], 40)], [door(0.9, 2)]);
    const a = build();
    const b = build();
    expect(JSON.stringify(computeMeasurements(a, evidenceFor(a)))).toBe(JSON.stringify(computeMeasurements(b, evidenceFor(b))));
    expect(JSON.stringify(walkwayTo(knowledgeOf(a, null), "sofa"))).toBe(JSON.stringify(walkwayTo(knowledgeOf(b, null), "sofa")));
    // Cached per Scene object: the same object, the same result.
    expect(measureScene(a)).toBe(measureScene(a));
  });

  it("reads a Scene without writing to it", () => {
    const scene = room(4, 5, [piece("sofa", "sofa", [0, -1], [2, 0.8, 0.9])], [door(0.9, 2)]);
    const before = JSON.stringify(scene);
    computeMeasurements(scene, evidenceFor(scene));
    walkwayTo(knowledgeOf(scene, null), "sofa");
    answer(scene, null, { kind: "clearance", objectId: "sofa" });
    expect(JSON.stringify(scene)).toBe(before);
  });

  it("says what it cannot measure instead of throwing or inventing a number", () => {
    const flat: Scene = { ...room(4, 5), room: { ...room(4, 5).room, footprint: [[0, 0], [1, 0]], height: 0 } };
    const m = computeMeasurements(flat, null);
    expect(m.room.width).toMatchObject({ available: false });
    expect(m.room.height).toMatchObject({ available: false });
    expect(m.floor.free).toMatchObject({ available: false });
    expect(formatMeasurement(m.room.width)).toBe("—");

    const broken = room(4, 5, [piece("nan", "cabinet", [0, 0], [Number.NaN, 1, 1]), piece("zero", "cabinet", [1, 1], [0, 1, 1])]);
    const b = computeMeasurements(broken, null);
    expect(b.objects[0].size.width).toMatchObject({ available: false });
    expect(b.objects[0].footprint).toBeNull();
    expect(b.objects[1].size.width).toMatchObject({ available: false });

    const wallless: Scene = { ...room(4, 5, [piece("box", "cabinet", [0, 0], [1, 1, 1])]), surfaces: [] };
    const w = computeMeasurements(wallless, null);
    expect(w.objects[0].wall).toBeNull();
    expect(w.openings).toEqual([]);
    expect(answer(wallless, null, { kind: "distance", from: "box", to: "nothing" })).toMatchObject({ ok: false });
    expect(answer(wallless, null, { kind: "object-size", objectId: "nothing" })).toMatchObject({ ok: false });
    expect(answer(wallless, null, { kind: "circulation-at-least", metres: -1 })).toMatchObject({ ok: false });
  });
});
