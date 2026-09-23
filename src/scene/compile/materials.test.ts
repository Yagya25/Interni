import { describe, expect, it } from "vitest";
import { adjustSlot, adjustSurface, resurface } from "@/features/workspace/state/edits";
import { commit, createDocument, redo, undo } from "@/features/workspace/state/document";
import { findById } from "@/scene/model/queries";
import type { Scene, Vec3 } from "@/scene/model/types";
import { DEFAULT_ROOM, syntheticInstances, syntheticIntermediate, type SyntheticRoom } from "./__fixtures__/synthetic";
import { compileRoomShell } from "./compileRoomShell";
import { yawRotate } from "./frame";
import type { AppearanceObservation, ColourStats, InstanceObservation, LightObservation, ReconstructionIntermediate } from "./intermediate";
import { parseIntermediate } from "./intermediate";
import { colourName, hexToLinear, MATERIAL_RULES } from "./materials";

// ---------------------------------------------------------------------------
// Observations as the worker's S6 writes them, for regions of the synthetic room.

const LUMA = [0.2126, 0.7152, 0.0722];

function colour(hex: string): ColourStats {
  const linear = hexToLinear(hex);
  return {
    pixels: 5000,
    wellExposedPixels: 4800,
    clippedFraction: 0,
    darkFraction: 0,
    linear,
    srgbHex: hex,
    luminance: linear.reduce((s, v, i) => s + v * LUMA[i], 0),
    spreadDeltaE: 3,
    palette: [{ srgbHex: hex, linear, share: 1 }],
  };
}

const CLASSES = ["wood", "fabric", "stone", "glass", "metal", "paint", "ceramic", "paper", "leather", "plant"];

function scores(best: Record<string, number>): AppearanceObservation["materialClass"] {
  const all = CLASSES.map((c) => ({ class: c, logit: best[c] ?? -8 }));
  return { subject: "test", scores: all.sort((a, b) => b.logit - a.logit), promptsVersion: "material-prompts-0.1", scoreKind: "test" };
}

const plane = (planeId: string, role: "floor" | "ceiling" | "wall", hex: string, best: Record<string, number>, extra: Partial<AppearanceObservation> = {}): AppearanceObservation => ({
  regionId: planeId,
  target: { kind: "plane", planeId, role },
  colour: colour(hex),
  materialClass: scores(best),
  ...extra,
});

const piece = (instanceId: string, phrase: string, hex: string, best: Record<string, number>, part?: string): AppearanceObservation => ({
  regionId: part ? `${instanceId}:${part}` : instanceId,
  target: part ? { kind: "part", instanceId, phrase, part, method: "test" } : { kind: "instance", instanceId, phrase },
  colour: colour(hex),
  materialClass: scores(best),
});

function light(overrides: Partial<LightObservation> = {}): LightObservation {
  const lightColour = { linearUnitLuminance: [1.15, 0.97, 0.82] as Vec3, srgbHex: "#ffeddc", xy: [0.3356, 0.3458] as const, cctK: 5370, cctMethod: "McCamy" };
  return {
    version: "lighting-0.1",
    illuminant: { greyWorld: { ...lightColour, pixels: 100000, note: "" }, ceiling: { ...lightColour, cctK: 5070, pixels: 20000, note: "" } },
    shading: { method: "test", regions: [], combined: null },
    gradient: null,
    openings: [],
    sunPatches: { method: "test", planes: [], fraction: 0.002 },
    emission: [],
    exposure: { interiorMedianLuminance: 0.15, interiorP99Luminance: 0.7, clippedFraction: 0.01, darkFraction: 0.01, note: "" },
    ...overrides,
  };
}

/** A lamp beside the default room's pieces, as the worker would measure it. */
function withLamp(room: SyntheticRoom): InstanceObservation[] {
  const base = syntheticInstances(room);
  const sofa = base[0];
  const lamp: InstanceObservation = {
    ...sofa,
    id: "instance-10",
    labels: [{ label: "floor lamp", score: 0.6 }],
    score: 0.6,
    heightRange: [0.02, 1.6],
    visibleBox: { ...sofa.visibleBox!, size: [0.4, 1.6, 0.4] },
    horizontalSurfaces: [],
    frontNormal: null,
  };
  return [...base, lamp];
}

function observed(parts: { appearance?: AppearanceObservation[]; light?: LightObservation | null; lamp?: boolean } = {}): ReconstructionIntermediate {
  const input = syntheticIntermediate({}, parts.lamp ? withLamp : syntheticInstances);
  const appearance = parts.appearance ?? [
    plane("plane-0", "floor", "#8e8782", { ceramic: 1, wood: -1, stone: -1.5 }, {
      reflections: [{ instanceId: "instance-5", reflectedPixels: 9000, contrast: 1.8, insideLuminance: 0.4, besideLuminance: 0.22, match: [], bestBlurPx: 8, bestBlurDeg: 0.41 }],
      texture: { method: "test", resolutionM: 0.0025, maxDistanceM: 3.6, analysedAreaM2: 2, specularExcludedFraction: 0.2, axes: [
        { name: "room-x", direction: [1, 0, 0], period: 0.36, strength: 0.29, harmonic: null },
        { name: "room-z", direction: [0, 0, 1], period: 0.56, strength: 0.26, harmonic: null },
      ] },
    }),
    plane("plane-1", "ceiling", "#9d8f80", { paint: -3, paper: -5 }),
    plane("plane-2", "wall", "#746148", { paint: -6, paper: -6.3 }),
    plane("plane-3", "wall", "#a18c70", { paint: -4.7, paper: -5 }),
    piece("instance-0", "sofa", "#72655e", { fabric: -1.3, leather: -3.8 }),
    piece("instance-1", "coffee table", "#282624", { wood: -0.2, stone: -1.6, glass: -4 }),
    piece("instance-3", "tv", "#2d2a24", { wood: -4 }),
    piece("instance-4", "picture frame", "#7e634d", { wood: -1 }),
    piece("instance-4", "picture frame", "#282017", { wood: -1, metal: -1.8 }, "frame"),
    piece("instance-4", "picture frame", "#836752", { paper: 0.6, fabric: -0.2 }, "surface"),
    piece("instance-5", "window", "#676c6f", { paint: -4.1, metal: -4.7 }, "frame"),
  ];
  return { ...input, world: { ...input.world, appearance, light: parts.light === undefined ? light() : parts.light } };
}

function compile(input: ReconstructionIntermediate) {
  const result = compileRoomShell(input);
  if (!result.ok) throw new Error(result.problem.code);
  return result;
}

const materialOf = (scene: Scene, id: string) => findById(scene.materials, id)!;

// ---------------------------------------------------------------------------

describe("material and light observations", () => {
  it("parse, and refuse a class the Scene does not have or a malformed colour", () => {
    expect(parseIntermediate(JSON.parse(JSON.stringify(observed()))).kind).toBe("run");

    const bad = observed();
    const velvet = JSON.parse(JSON.stringify(bad));
    velvet.world.appearance[0].materialClass.scores[0].class = "velvet";
    expect(parseIntermediate(velvet)).toMatchObject({ kind: "invalid", reason: expect.stringContaining("not a Scene material class") });

    const hex = JSON.parse(JSON.stringify(bad));
    hex.world.appearance[1].colour.srgbHex = "beige";
    expect(parseIntermediate(hex)).toMatchObject({ kind: "invalid", reason: expect.stringContaining("#rrggbb") });

    const noLight = JSON.parse(JSON.stringify(bad));
    delete noLight.world.light.illuminant;
    expect(parseIntermediate(noLight)).toMatchObject({ kind: "invalid", reason: expect.stringContaining("illuminant") });
  });
});

describe("materials from the photograph", () => {
  it("gives every surface and piece the colour its own region was photographed in", () => {
    const { scene, evidence } = compile(observed());
    const floor = materialOf(scene, scene.surfaces.find((s) => s.kind === "floor")!.materialId);
    expect(floor).toMatchObject({ id: "m-floor", class: "ceramic", color: "#8e8782" });
    expect(evidence.entities["m-floor"].fields.class.basis).toBe("estimated");
    const sofa = scene.objects.find((o) => o.category === "sofa")!;
    expect(materialOf(scene, sofa.materials.upholstery)).toMatchObject({ class: "fabric", color: "#72655e", pattern: "weave" });
    // Nothing the photograph did not give: every material either traces to a region or says it is a stand-in.
    for (const m of scene.materials) {
      const e = evidence.entities[m.id];
      expect(e, m.id).toBeDefined();
      expect(e.observations.length > 0 || e.presence.basis === "default", m.id).toBe(true);
    }
  });

  it("reads gloss from the opening mirrored in the floor, and says the tile size was not measured", () => {
    const { scene, evidence } = compile(observed());
    const floor = materialOf(scene, "m-floor");
    expect(floor.roughness).toBe(0.18);
    expect(floor.name).toMatch(/glossy/);
    expect(evidence.entities["m-floor"].fields.roughness).toMatchObject({ basis: "estimated", value: 0.18 });
    expect(floor.pattern).toBe("tiles");
    expect(evidence.entities["m-floor"].fields.pattern.basis).toBe("default");
    expect(floor.patternScale).toBe(MATERIAL_RULES.tiles.defaultSize * MATERIAL_RULES.tiles.perRepeat);
  });

  it("measures the tiles when both axes of the rectified floor agree", () => {
    const input = observed();
    const floor = input.world.appearance[0];
    const agreeing = { ...floor, texture: { ...floor.texture!, axes: floor.texture!.axes.map((a, i) => ({ ...a, period: i ? 0.52 : 0.5 })) } };
    const { scene, evidence } = compile({ ...input, world: { ...input.world, appearance: [agreeing, ...input.world.appearance.slice(1)] } });
    expect(materialOf(scene, "m-floor").patternScale).toBe(2.04);
    expect(evidence.entities["m-floor"].fields.pattern.basis).toBe("estimated");
  });

  it("paints walls of one chromaticity with one paint, coloured by the best lit, classed from all of them", () => {
    const { scene, report, evidence } = compile(observed());
    const walls = scene.surfaces.filter((s) => s.kind === "wall");
    expect(new Set(walls.map((w) => w.materialId))).toEqual(new Set(["m-wall"]));
    expect(materialOf(scene, "m-wall").color).toBe("#a18c70"); // the brighter of the two seen
    // Alone, the left wall's paint-versus-paper margin (0.3) is under the bar; with the far wall's (0.3) it still is.
    expect(evidence.entities["m-wall"].fields.class.basis).toBe("default");
    expect(report.materials.shared[0].members).toContain("wall-left");
  });

  it("keeps walls of different colours apart", () => {
    const input = observed();
    const appearance = input.world.appearance.map((a) => (a.regionId === "plane-2" ? { ...a, colour: colour("#6a7f95") } : a));
    const { scene } = compile({ ...input, world: { ...input.world, appearance } });
    expect(new Set(scene.surfaces.filter((s) => s.kind === "wall").map((w) => w.materialId)).size).toBe(2);
  });

  it("falls back to the slot's typical class when SigLIP cannot tell, and keeps the reading", () => {
    const input = observed();
    const appearance = input.world.appearance.map((a) => (a.regionId === "instance-0" ? { ...a, materialClass: scores({ leather: -1, fabric: -1.2 }) } : a));
    const { scene, evidence } = compile({ ...input, world: { ...input.world, appearance } });
    const sofa = scene.objects.find((o) => o.category === "sofa")!;
    const e = evidence.entities[sofa.materials.upholstery];
    expect(materialOf(scene, sofa.materials.upholstery).class).toBe("fabric");
    expect(e.fields.class.basis).toBe("default");
    expect(e.fields.class.note).toMatch(/could not tell leather from fabric/);
    expect(e.alternatives).toContainEqual({ field: "class", value: "fabric", score: -1.2 });
  });

  it("never classifies what the category settles, and reads a picture's frame and surface apart", () => {
    const { scene, evidence } = compile(observed());
    const tv = scene.objects.find((o) => o.category === "television")!;
    expect(materialOf(scene, tv.materials.screen).class).toBe("glass");
    expect(evidence.entities[tv.materials.screen].fields.class.basis).toBe("inferred");
    const art = scene.objects.find((o) => o.category === "artwork")!;
    expect(materialOf(scene, art.materials.frame)).toMatchObject({ class: "wood", color: "#282017" });
    expect(materialOf(scene, art.materials.surface)).toMatchObject({ class: "paper", color: "#836752" });
    const window = scene.openings.find((o) => o.kind === "window")!;
    expect(materialOf(scene, window.frameMaterialId).color).toBe("#676c6f");
  });

  it("without appearance observations, leaves every finish a stated stand-in", () => {
    const { scene } = compile(observed({ appearance: [], light: null }));
    expect(scene.surfaces.map((s) => s.materialId)).toEqual(["unestimated-floor", "unestimated-ceiling", "unestimated-wall", "unestimated-wall", "unestimated-wall"]);
    const sofa = scene.objects.find((o) => o.category === "sofa")!;
    expect(materialOf(scene, sofa.materials.upholstery).name).toMatch(/material not estimated/);
  });
});

describe("light from the photograph", () => {
  it("records the light's colour without applying it twice, and keeps diffuse daylight's sun out", () => {
    const { scene, evidence, report } = compile(observed());
    // The surfaces' apparent colours already carry the light's colour, so the light stays neutral.
    expect(scene.lights.find((l) => l.kind === "ambient")).toMatchObject({ color: "#ffffff" });
    expect(evidence.entities.ambient.fields.measuredColor.value).toBe("#ffeddc");
    expect(evidence.entities.ambient.fields.cctK.value).toBe(5370);
    expect(report.lighting.colour).toMatchObject({ hex: "#ffeddc", applied: "#ffffff" });
    expect(scene.lights.find((l) => l.kind === "daylight")).toMatchObject({ direct: false, openingIds: ["window-0"] });
    expect(report.lighting.daylight.direct).toBe(false);
  });

  it("leaves the renderer's sun in when sunlit patches were seen", () => {
    const { scene } = compile(observed({ light: light({ sunPatches: { method: "test", planes: [], fraction: 0.04 } }) }));
    expect(scene.lights.find((l) => l.kind === "daylight")).not.toHaveProperty("direct");
  });

  it("switches a lamp on only when its shade is seen lit", () => {
    const shade = (toSurround: number) => light({ emission: [{ instanceId: "instance-10", phrase: "floor lamp", p99ToInterior: 2, clippedFraction: 0, shade: { medianLuminance: 0.3, surroundMedianLuminance: 0.1, toSurround, clippedFraction: 0 } }] });
    const lit = compile(observed({ lamp: true, light: shade(3) })).scene.lights.find((l) => l.kind === "artificial");
    expect(lit).toMatchObject({ on: true, label: expect.stringContaining("seen lit") });
    const unlit = compile(observed({ lamp: true, light: shade(0.6) })).scene.lights.find((l) => l.kind === "artificial");
    expect(unlit).not.toHaveProperty("on");
    expect(unlit?.label).toMatch(/seen unlit/);
  });

  it("checks the shading direction against the openings, and reports one no opening explains", () => {
    const toward = (v: Vec3) => light({ shading: { method: "test", regions: [], combined: { towardsLight: v, directionality: 0.9, agreement: 0.8, regions: 6, weighting: "test" } } });
    // The synthetic window is in the far wall, which faces +Z in the room: light from there travels towards the camera.
    const room = compile(observed());
    const far = room.scene.openings[0];
    expect(far.wallId).toBe("wall-far");
    const fromWindow = compile(observed({ light: toward(capture([0.1, 0.2, -1])) }));
    expect(fromWindow.report.lighting.direction?.nearestOpening?.id).toBe("window-0");
    expect(fromWindow.report.problems.map((p) => p.code)).not.toContain("light-from-no-opening");
    const fromBehind = compile(observed({ light: toward(capture([0, 0.2, 1])) }));
    expect(fromBehind.report.problems.map((p) => p.code)).toContain("light-from-no-opening");
  });
});

describe("compiling materials and light", () => {
  it("gives the same bytes every time", () => {
    const a = JSON.stringify(compile(observed()));
    expect(JSON.stringify(compile(observed()))).toBe(a);
  });

  it("edits a reconstructed finish through the history: change, undo, redo", () => {
    const { scene } = compile(observed());
    let doc = createDocument(scene, "test");
    const floor = scene.surfaces.find((s) => s.kind === "floor")!;
    const sofa = scene.objects.find((o) => o.category === "sofa")!;
    const found = materialOf(scene, sofa.materials.upholstery);

    doc = commit(doc, adjustSlot(sofa, "upholstery", found, { color: "#335577" }, "colour").operations, "sofa colour");
    doc = commit(doc, resurface(floor, materialOf(scene, "m-wall")).operations, "floor like the walls");
    doc = commit(doc, adjustSurface(floor, materialOf(doc.scene, "m-wall"), { roughness: 0.6 }, "roughness").operations, "floor roughness");
    const edited = doc.scene;
    const editedSofa = findById(edited.objects, sofa.id)!;
    expect(materialOf(edited, editedSofa.materials.upholstery)).toMatchObject({ color: "#335577", name: expect.stringContaining("(edited)") });
    expect(materialOf(edited, edited.surfaces.find((s) => s.kind === "floor")!.materialId).roughness).toBe(0.6);

    doc = undo(undo(undo(doc)));
    expect(doc.scene.surfaces).toEqual(scene.surfaces);
    expect(findById(doc.scene.objects, sofa.id)).toEqual(sofa);
    // The reconstructed finishes are all still in the library, unchanged.
    for (const m of scene.materials) expect(findById(doc.scene.materials, m.id)).toEqual(m);

    doc = redo(redo(redo(doc)));
    expect(doc.scene.surfaces).toEqual(edited.surfaces);
    expect(findById(doc.scene.objects, sofa.id)).toEqual(editedSofa);
  });

  it("records no history for an adjustment that changes nothing", () => {
    // A number field applies its value while typing and again on Enter: the second is a no-op.
    const { scene } = compile(observed());
    const sofa = scene.objects.find((o) => o.category === "sofa")!;
    const found = materialOf(scene, sofa.materials.upholstery);
    let doc = commit(createDocument(scene, "test"), adjustSlot(sofa, "upholstery", found, { roughness: 0.4 }, "roughness").operations, "roughness");
    const once = doc;
    doc = commit(doc, adjustSlot(findById(doc.scene.objects, sofa.id)!, "upholstery", found, { roughness: 0.4 }, "roughness").operations, "roughness");
    expect(doc).toBe(once);
    expect(undo(doc).scene.objects).toEqual(scene.objects);
  });
});

it("names colours plainly", () => {
  expect(colourName("#a18c70")).toBe("beige");
  expect(colourName("#1d110b")).toMatch(/very dark brown|black/);
  expect(colourName("#ffffff")).toBe("white");
  expect(colourName("#8e8782")).toMatch(/grey/);
});

/** A room-axes direction as the worker writes it: the synthetic capture frame is the room's turned by −yaw. */
function capture(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return yawRotate([v[0] / l, v[1] / l, v[2] / l], -DEFAULT_ROOM.yawDeg);
}
