import { describe, expect, it } from "vitest";
import { applyOperations } from "@/scene/model/operations";
import { findById, roomBounds } from "@/scene/model/queries";
import type { Material, Scene } from "@/scene/model/types";
import { syntheticInstances, syntheticIntermediate } from "@/scene/compile/__fixtures__/synthetic";
import { compileRoomShell } from "@/scene/compile";
import { analyseScene } from "./analysis";
import { generateProposals } from "./generate";
import { axesOf, MAX_VARIANTS, validateDesignIntent, type DesignIntent } from "./intent";
import { readBrief, readDesignRequest } from "./read";
import { applied, fromIntent, previewing, proposalAt } from "./session";
import { STYLES, STYLE_ORDER, resolveScheme, styleFor } from "./styles";
import { validateOperations } from "./validate";

/**
 * The design engine, against a room whose every dimension is known: the
 * synthetic observations the compiler is itself tested with. The real
 * reconstructed room is exercised separately (`realRoomDesign.test.ts`);
 * what is checked here is the engine's own reasoning.
 */

function room(): Scene {
  const compiled = compileRoomShell(syntheticIntermediate({ scaleError: 1 }, syntheticInstances));
  if (!compiled.ok) throw new Error(compiled.problem.code);
  return compiled.scene;
}

const ROOM = room();
const intentOf = (text: string): DesignIntent => {
  const checked = validateDesignIntent(readBrief(text));
  if (!checked.ok) throw new Error(checked.reason);
  return checked.intent;
};

describe("reading a design request", () => {
  it("tells a design request from an edit command", () => {
    // Design: a style, a version, an atmosphere.
    expect(readDesignRequest("Give me 3 modern designs")).toEqual({ kind: "brief" });
    expect(readDesignRequest("Show me a Scandinavian version")).toEqual({ kind: "brief" });
    expect(readDesignRequest("Make this room feel warmer and more luxurious")).toEqual({ kind: "brief" });
    expect(readDesignRequest("Give me a cozy design")).toEqual({ kind: "brief" });

    // Edits, which keep their own path: one change to this room, not a direction for it.
    for (const text of ["make the room warmer", "make the room brighter", "move the sofa left", "make the sofa darker", "remove the ottoman", "reset the room"]) {
      expect(readDesignRequest(text)).toBeNull();
    }
  });

  it("reads styles, atmosphere and how many directions were asked for", () => {
    expect(intentOf("Give me 3 modern designs")).toMatchObject({ styles: ["MODERN_WARM"], variantCount: 3 });
    expect(intentOf("Give me a Scandinavian design")).toMatchObject({ styles: ["SCANDINAVIAN"], variantCount: 1 });
    // "Dark contemporary" is one style, not "dark" applied to "modern".
    expect(intentOf("Make this room darker and more contemporary")).toMatchObject({ styles: ["DARK_CONTEMPORARY"], brightness: -0.65 });
    expect(intentOf("Make this room feel warmer and more luxurious")).toMatchObject({ warmth: 0.65, luxury: 0.65, atmosphere: "warmer, luxurious" });
    expect(intentOf("a much cozier design")).toMatchObject({ coziness: 1 });
    expect(intentOf("a slightly warmer design")).toMatchObject({ warmth: 0.35 });
    // "Less warm" counts against the axis rather than for it.
    expect(intentOf("a less warm design")).toMatchObject({ warmth: -0.65 });
    expect(intentOf("give me a couple of design options")).toMatchObject({ variantCount: 2 });
    expect(intentOf("some design ideas")).toMatchObject({ variantCount: MAX_VARIANTS });
  });

  it("reads an act on the directions already on screen", () => {
    expect(readDesignRequest("apply the second design")).toEqual({ kind: "session", action: "apply", ordinal: 2 });
    expect(readDesignRequest("apply design 3")).toEqual({ kind: "session", action: "apply", ordinal: 3 });
    expect(readDesignRequest("apply this design")).toEqual({ kind: "session", action: "apply", ordinal: null });
    expect(readDesignRequest("preview the first one")).toEqual({ kind: "session", action: "preview", ordinal: 1 });
    expect(readDesignRequest("exit preview")).toEqual({ kind: "session", action: "dismiss", ordinal: null });
    // A style named is always a new brief, never an act on what is on screen.
    expect(readDesignRequest("show me a Scandinavian version")).toEqual({ kind: "brief" });
  });
});

describe("the provider boundary", () => {
  it("refuses anything that is not a design intent, by name", () => {
    expect(validateDesignIntent({ styles: [] })).toMatchObject({ ok: true });
    expect(validateDesignIntent({ styles: ["BRUTALIST"] })).toMatchObject({ ok: false, reason: expect.stringMatching(/styles\[0\] must be one of/) });
    expect(validateDesignIntent({ styles: ["COZY", "COZY"] })).toMatchObject({ ok: false, reason: "styles must not repeat" });
    expect(validateDesignIntent({ styles: [], warmth: 4 })).toMatchObject({ ok: false, reason: "warmth must be between -1 and 1" });
    expect(validateDesignIntent({ styles: [], warmth: "a lot" })).toMatchObject({ ok: false, reason: expect.stringMatching(/finite number/) });
    expect(validateDesignIntent({ styles: [], variantCount: 9 })).toMatchObject({ ok: false, reason: `variantCount must be at most ${MAX_VARIANTS}` });
    expect(validateDesignIntent({ styles: [], variantCount: 1.5 })).toMatchObject({ ok: false, reason: expect.stringMatching(/whole number/) });
    expect(validateDesignIntent({ styles: [], version: "design-intent-9" })).toMatchObject({ ok: false });
    expect(validateDesignIntent("modern please")).toMatchObject({ ok: false, reason: "intent must be an object" });
    expect(validateDesignIntent(null)).toMatchObject({ ok: false });
  });

  it("takes the same intent from any provider, and gives the same proposals", () => {
    // A test double standing in for a model's JSON. Not a model.
    const asJson = JSON.parse(JSON.stringify(intentOf("Give me 3 modern designs")));
    const checked = validateDesignIntent(asJson);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const fromRules = generateProposals(ROOM, intentOf("Give me 3 modern designs"));
    const fromModel = generateProposals(ROOM, checked.intent);
    expect(JSON.stringify(fromModel.proposals)).toBe(JSON.stringify(fromRules.proposals));
  });
});

describe("the analysis", () => {
  it("reads the room from the Scene and invents nothing", () => {
    const analysis = analyseScene(ROOM);
    expect(analysis.version).toBe("design-analysis-0.2");
    expect(analysis.room.width).toBeCloseTo(roomBounds(ROOM).max[0] - roomBounds(ROOM).min[0], 3);
    expect(analysis.furniture.count).toBe(ROOM.objects.length);
    expect(analysis.materials.walls.map((w) => w.surfaceId)).toEqual(ROOM.surfaces.filter((s) => s.kind === "wall").map((s) => s.id));
    // Every finish it lists is a finish the Scene holds.
    for (const slot of analysis.materials.slots) {
      expect(findById(ROOM.objects, slot.objectId)!.materials[slot.slot]).toBe(slot.materialId);
      expect(findById(ROOM.materials, slot.materialId)!.color).toBe(slot.color);
    }
    expect(analysis.furniture.density).toBeGreaterThan(0);
    expect(analysis.furniture.density).toBeLessThanOrEqual(1);
    expect(analysis.furniture.freeArea).toBeCloseTo(analysis.room.floorArea - analysis.furniture.occupiedArea, 3);
    expect(analysis.lighting.lamps.every((l) => ROOM.lights.some((light) => light.id === l.id))).toBe(true);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(analyseScene(ROOM))).toBe(JSON.stringify(analyseScene(room())));
  });
});

describe("styles", () => {
  it("has six presets, each with three readings and a distinct palette", () => {
    expect(STYLE_ORDER).toHaveLength(6);
    const walls = new Set<string>();
    for (const style of STYLE_ORDER) {
      const preset = STYLES[style];
      expect(preset.variants).toHaveLength(3);
      expect(new Set(preset.variants.map((v) => v.key)).size).toBe(3);
      walls.add(preset.palette.wall);
      // A dark style must not close the room in: its ceiling stays lighter than its walls.
      expect(preset.palette.ceiling).not.toBe(preset.palette.wall);
    }
    expect(walls.size).toBe(6);
  });

  it("picks the style the axes point at, and the listed order breaks ties", () => {
    expect(styleFor(axesOf(intentOf("a cozy design")))).toBe("COZY");
    expect(styleFor(axesOf(intentOf("a more luxurious design")))).toBe("CLASSIC_ELEGANT");
    expect(styleFor(axesOf(intentOf("a brighter, airier design")))).toBe("SCANDINAVIAN");
    // Nothing asked for at all: the first listed style.
    expect(styleFor(axesOf(intentOf("give me a design")))).toBe(STYLE_ORDER[0]);
  });

  it("lets a request nudge a style without replacing it", () => {
    const preset = STYLES.SCANDINAVIAN;
    const plain = resolveScheme(preset, preset.variants[0], axesOf(intentOf("a scandinavian design")));
    const warmed = resolveScheme(preset, preset.variants[0], axesOf(intentOf("a warmer scandinavian design")));
    expect(warmed.palette.wall).not.toBe(plain.palette.wall);
    expect(warmed.light.kelvin).toBeLessThan(plain.light.kelvin);
    expect(warmed.title).toBe(plain.title);
  });
});

describe("generating proposals", () => {
  it("gives one valid proposal per direction asked for, and no two alike", () => {
    const result = generateProposals(ROOM, intentOf("Give me 3 modern designs"));
    expect(result.ok).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(result.proposals.map((p) => p.title)).toEqual(["Modern Warm", "Modern Neutral", "Modern Dark Accent"]);
    expect(new Set(result.proposals.map((p) => JSON.stringify(p.operations))).size).toBe(3);
    for (const proposal of result.proposals) {
      expect(proposal.status).toBe("draft");
      expect(proposal.operations.length).toBeGreaterThan(0);
      expect(proposal.preview.operationCount).toBe(proposal.operations.length);
      expect(proposal.rationale.length).toBeGreaterThan(0);
      expect(proposal.constraints.length).toBeGreaterThan(0);
      expect(validateOperations(ROOM, proposal.operations)).toEqual({ ok: true });
    }
  });

  it("spreads across styles when no style is named, and stays inside one when it is", () => {
    expect(generateProposals(ROOM, intentOf("give me 3 designs")).proposals.map((p) => p.style)).toEqual(["MODERN_WARM", "SCANDINAVIAN", "MINIMAL_NEUTRAL"]);
    expect(generateProposals(ROOM, intentOf("give me 3 scandinavian designs")).proposals.map((p) => p.style)).toEqual(["SCANDINAVIAN", "SCANDINAVIAN", "SCANDINAVIAN"]);
  });

  it("only ever proposes finishes and light: nothing is added, moved or taken away", () => {
    for (const style of STYLE_ORDER) {
      const result = generateProposals(ROOM, { ...intentOf("give me a design"), styles: [style] });
      const kinds = new Set(result.proposals.flatMap((p) => p.operations.map((o) => o.kind)));
      expect([...kinds].sort()).toEqual(["relight", "restyle", "resurface"]);
      const after = applyOperations(ROOM, result.proposals[0].operations);
      expect(after.objects.map((o) => o.id)).toEqual(ROOM.objects.map((o) => o.id));
      expect(after.objects.map((o) => o.transform)).toEqual(ROOM.objects.map((o) => o.transform));
      expect(after.surfaces.map((s) => s.id)).toEqual(ROOM.surfaces.map((s) => s.id));
    }
  });

  it("keeps a floor the style says to keep, and tints one it does not", () => {
    const floorOf = (scene: Scene) => findById(scene.materials, scene.surfaces.find((s) => s.kind === "floor")!.materialId)!;
    const scandinavian = generateProposals(ROOM, intentOf("a scandinavian design")).proposals[0];
    const after = applyOperations(ROOM, scandinavian.operations);
    const floor = ROOM.surfaces.find((s) => s.kind === "floor")!;
    if (STYLES.SCANDINAVIAN.floor.keep.includes(floorOf(ROOM).class)) {
      expect(after.surfaces.find((s) => s.id === floor.id)!.materialId).toBe(floor.materialId);
      expect(scandinavian.constraints.join(" ")).toMatch(/floor/i);
    } else {
      expect(floorOf(after).color).not.toBe(floorOf(ROOM).color);
    }
  });

  it("never proposes a change the room already has", () => {
    const first = generateProposals(ROOM, intentOf("a cozy design")).proposals[0];
    const after = applyOperations(ROOM, first.operations);
    // Asked again of the room it produced, the same direction has nothing left to do.
    const again = generateProposals(after, intentOf("a cozy design"));
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already reads that way/);
    expect(again.rejected[0]).toMatchObject({ title: "Cozy Amber" });
  });

  it("is deterministic: the same room and intent give byte-identical proposals", () => {
    for (const text of ["Give me 3 modern designs", "a cozy design", "Make this room feel warmer and more luxurious", "give me 3 designs"]) {
      const a = generateProposals(room(), intentOf(text));
      const b = generateProposals(room(), intentOf(text));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      // And the ids are the same from one run to the next, so a card keeps its name.
      expect(a.proposals.map((p) => p.id)).toEqual(b.proposals.map((p) => p.id));
    }
  });
});

describe("validation", () => {
  const material = (over: Partial<Material> = {}): Material => ({ id: "test", class: "fabric", name: "Test", color: "#aabbcc", roughness: 0.5, metalness: 0, pattern: "none", ...over });
  const sofa = ROOM.objects.find((o) => o.category === "sofa")!;
  const wall = ROOM.surfaces.find((s) => s.kind === "wall")!;

  it("passes what the engine produces", () => {
    const proposal = generateProposals(ROOM, intentOf("a modern design")).proposals[0];
    expect(validateOperations(ROOM, proposal.operations)).toEqual({ ok: true });
  });

  it("refuses an operation the room cannot take, with a reason", () => {
    expect(validateOperations(ROOM, [])).toMatchObject({ ok: false, reason: "the proposal would change nothing" });
    expect(validateOperations(ROOM, [{ kind: "restyle", objectId: "ghost-0", slot: "upholstery", to: material() }])).toMatchObject({ ok: false, reason: expect.stringMatching(/no object ghost-0/) });
    expect(validateOperations(ROOM, [{ kind: "restyle", objectId: sofa.id, slot: "wheels", to: material() }])).toMatchObject({ ok: false, reason: expect.stringMatching(/no wheels/) });
    // A finish a slot cannot take: the allowed classes are the compiler's, not the design engine's.
    expect(validateOperations(ROOM, [{ kind: "restyle", objectId: sofa.id, slot: "upholstery", to: material({ class: "glass" }) }])).toMatchObject({ ok: false, reason: expect.stringMatching(/can be fabric or leather, not glass/) });
    expect(validateOperations(ROOM, [{ kind: "resurface", surfaceId: wall.id, to: material({ class: "fabric" }) }])).toMatchObject({ ok: false, reason: expect.stringMatching(/can be paint or paper/) });
    expect(validateOperations(ROOM, [{ kind: "resurface", surfaceId: wall.id, to: material({ class: "paint", color: "rebeccapurple" as never }) }])).toMatchObject({ ok: false });
    expect(validateOperations(ROOM, [{ kind: "relight", lightId: "no-such-light", to: { intensity: 1.2 } }])).toMatchObject({ ok: false, reason: expect.stringMatching(/no light/) });
    const daylight = ROOM.lights.find((l) => l.kind === "daylight")!;
    expect(validateOperations(ROOM, [{ kind: "relight", lightId: daylight.id, to: { timeOfDay: 4 } }])).toMatchObject({ ok: false, reason: expect.stringMatching(/0 \(midday\) to 1/) });
  });

  it("refuses to add, remove or replace anything at all", () => {
    expect(validateOperations(ROOM, [{ kind: "remove", objectId: sofa.id }])).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot take furniture out/) });
    expect(validateOperations(ROOM, [{ kind: "add", object: sofa, index: 0 }])).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot add furniture/) });
    expect(validateOperations(ROOM, [{ kind: "replace", objectId: sofa.id, replacement: sofa }])).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot swap/) });
  });

  it("refuses a transform that would leave the room, though the engine makes none", () => {
    expect(validateOperations(ROOM, [{ kind: "move", objectId: sofa.id, to: [40, 0, 40], rotationY: 0 }])).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the room/) });
    expect(validateOperations(ROOM, [{ kind: "scale", objectId: sofa.id, to: [9, 9, 9] }])).toMatchObject({ ok: false, reason: expect.stringMatching(/past what this editor allows/) });
  });
});

describe("a session", () => {
  const session = () => {
    const outcome = fromIntent("give me 3 modern designs", intentOf("give me 3 modern designs"), ROOM);
    if (outcome.outcome !== "designs") throw new Error(outcome.message);
    return outcome.session;
  };

  it("tracks what is previewed and what was applied, without touching the Scene", () => {
    const start = session();
    expect(start.proposals.every((p) => p.status === "draft")).toBe(true);
    expect(start.previewId).toBeNull();

    const looking = previewing(start, start.proposals[1].id);
    expect(looking.proposals.map((p) => p.status)).toEqual(["draft", "preview", "draft"]);
    // The proposals themselves are untouched: a session is a new value, not a mutation.
    expect(start.proposals.every((p) => p.status === "draft")).toBe(true);

    const taken = applied(looking, looking.proposals[1].id);
    expect(taken.proposals.map((p) => p.status)).toEqual(["rejected", "applied", "rejected"]);
    expect(taken.previewId).toBeNull();
    expect(taken.appliedId).toBe(looking.proposals[1].id);
  });

  it("finds the proposal an ordinal names", () => {
    const start = session();
    expect(proposalAt(start, 2)!.id).toBe(start.proposals[1].id);
    expect(proposalAt(start, -1)!.id).toBe(start.proposals[2].id);
    expect(proposalAt(start, 9)).toBeNull();
    // With no ordinal, the one being looked at — and nothing when none is.
    expect(proposalAt(start, null)).toBeNull();
    expect(proposalAt(previewing(start, start.proposals[0].id), null)!.id).toBe(start.proposals[0].id);
  });
});
