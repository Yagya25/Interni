import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { applyOperations } from "@/scene/model/operations";
import { findById } from "@/scene/model/queries";
import { luminance, warmth } from "@/scene/model/colour";
import type { ArtificialLight, DaylightSource, Scene } from "@/scene/model/types";
import { createRoomInterpreter } from "../ai/roomInterpreter";
import { WorkspaceStore } from "../state/store";
import { analyseScene } from "./analysis";
import { generateProposals } from "./generate";
import { validateDesignIntent, type DesignIntent } from "./intent";
import { readBrief } from "./read";
import { validateOperations } from "./validate";

/**
 * Designs for the room in the photograph.
 *
 * The same real worker output the AI command tests use (download.png),
 * compiled exactly as the browser compiles it. Every direction below is
 * generated against that room — 16 pieces, one glazed door, a ceramic
 * floor, a floor lamp the photograph found unlit — and not against a toy.
 */
const FIXTURE = new URL("../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);

function realRoom(): Scene {
  const parsed = parseIntermediate(JSON.parse(readFileSync(FIXTURE, "utf8")));
  if (parsed.kind !== "run") throw new Error("the fixture is not a run");
  const compiled = compileRoomShell(parsed.intermediate);
  if (!compiled.ok) throw new Error(compiled.problem.code);
  return compiled.scene;
}

const ROOM = realRoom();
const signal = () => new AbortController().signal;

const intentOf = (text: string): DesignIntent => {
  const checked = validateDesignIntent(readBrief(text));
  if (!checked.ok) throw new Error(checked.reason);
  return checked.intent;
};
const designs = (text: string, scene: Scene = ROOM) => {
  const result = generateProposals(scene, intentOf(text));
  if (!result.ok) throw new Error(result.reason);
  return result.proposals;
};
const wallColour = (scene: Scene) => findById(scene.materials, scene.surfaces.find((s) => s.kind === "wall")!.materialId)!.color;
const hour = (scene: Scene) => (scene.lights.find((l) => l.kind === "daylight") as DaylightSource | undefined)?.timeOfDay;
const lamp = (scene: Scene) => scene.lights.find((l): l is ArtificialLight => l.kind === "artificial")!;
/** Every finish that covers this room, so a palette can be compared as a whole. */
const covering = (scene: Scene) => {
  const analysis = analyseScene(scene);
  return [...analysis.materials.walls, ...analysis.materials.slots, ...(analysis.materials.floor ? [analysis.materials.floor] : [])];
};
const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;

describe("the room the photograph gave", () => {
  it("is read as it stands, with nothing invented", () => {
    const analysis = analyseScene(ROOM);
    expect(analysis.room).toMatchObject({ width: 3.724, depth: 6.418, height: 2.998 });
    expect(analysis.furniture.count).toBe(16);
    expect(analysis.furniture.focal).toBe("television-0");
    expect([...analysis.furniture.seating].sort()).toEqual(["armchair-0", "armchair-1", "chair-0", "ottoman-0", "sofa-0"]);
    expect([...analysis.furniture.wallMounted].sort()).toEqual(["artwork-0", "artwork-1", "artwork-2", "artwork-3", "curtain-0", "curtain-1", "television-0"]);
    expect(analysis.materials.walls.map((w) => w.surfaceId)).toEqual(["wall-far", "wall-left", "wall-right"]);
    expect(analysis.materials.floor).toMatchObject({ class: "ceramic" });
    // The lamp the photograph found unlit, and the daylight through the glazed door.
    expect(analysis.lighting.unlit).toEqual(["light-floor-lamp-0"]);
    expect(analysis.lighting.daylight).toMatchObject({ openingIds: ["window-0"], direct: false });
    expect(analysis.spatialConstraints.againstWall).toContainEqual({ objectId: "sofa-0", wallId: "wall-left" });
  });
});

describe("directions for the real room", () => {
  it("gives three modern designs, each valid and none a copy of another", () => {
    const proposals = designs("Give me 3 modern designs.");
    expect(proposals.map((p) => p.title)).toEqual(["Modern Warm", "Modern Neutral", "Modern Dark Accent"]);
    for (const proposal of proposals) {
      expect(validateOperations(ROOM, proposal.operations)).toEqual({ ok: true });
      expect(proposal.preview.operationCount).toBeGreaterThan(10);
      expect(proposal.affectedObjects.length).toBeGreaterThan(5);
      expect(proposal.affectedLighting.length).toBeGreaterThan(0);
      // Every id it claims to touch is a real one in this room.
      for (const id of proposal.affectedObjects) expect(findById(ROOM.objects, id)).toBeDefined();
      for (const id of proposal.affectedLighting) expect(findById(ROOM.lights, id)).toBeDefined();
    }
    expect(new Set(proposals.map((p) => wallColour(applyOperations(ROOM, p.operations)))).size).toBe(3);
  });

  it("gives one Scandinavian design: lighter walls, a brighter hour", () => {
    const [scandinavian] = designs("Give me a Scandinavian design.");
    expect(scandinavian.style).toBe("SCANDINAVIAN");
    const after = applyOperations(ROOM, scandinavian.operations);
    expect(luminance(wallColour(after))).toBeGreaterThan(luminance(wallColour(ROOM)));
    expect(hour(after)!).toBeLessThan(hour(ROOM) ?? 0.18);
  });

  it("makes the room warmer and more luxurious when that is what was asked", () => {
    const [proposal] = designs("Make this room feel warmer and more luxurious.");
    expect(proposal.style).toBe("CLASSIC_ELEGANT");
    const after = applyOperations(ROOM, proposal.operations);
    // Warmer as a palette, not only in one place.
    expect(mean(covering(after).map((f) => warmth(f.color)))).toBeGreaterThan(mean(covering(ROOM).map((f) => warmth(f.color))));
    // And in the light: a later hour and a warmer bulb.
    expect(hour(after)!).toBeGreaterThan(hour(ROOM) ?? 0.18);
    expect(lamp(after).colorTemperature).toBeLessThanOrEqual(lamp(ROOM).colorTemperature);
    expect(proposal.changes.map((c) => c.group)).toContain("Materials");
    expect(proposal.changes.map((c) => c.group)).toContain("Lighting");
  });

  it("makes it darker and more contemporary without closing the room in", () => {
    const [proposal] = designs("Make this room darker and more contemporary.");
    expect(proposal.style).toBe("DARK_CONTEMPORARY");
    const after = applyOperations(ROOM, proposal.operations);
    expect(luminance(wallColour(after))).toBeLessThan(luminance(wallColour(ROOM)));
    // The ceiling stays lighter than the walls, which is the style's own constraint.
    const ceiling = findById(after.materials, after.surfaces.find((s) => s.kind === "ceiling")!.materialId)!;
    expect(luminance(ceiling.color)).toBeGreaterThan(luminance(wallColour(after)));
    expect(proposal.constraints).toContain("The ceiling stays lighter than the walls");
    // Not everything painted black: the palette still has range.
    const lightnesses = covering(after).map((f) => luminance(f.color));
    expect(Math.max(...lightnesses) - Math.min(...lightnesses)).toBeGreaterThan(0.2);
  });

  it("gives a cozy design: warm finishes, a late hour, and the unlit lamp switched on", () => {
    const [proposal] = designs("Give me a cozy design.");
    expect(proposal.style).toBe("COZY");
    const after = applyOperations(ROOM, proposal.operations);
    expect(hour(after)!).toBeGreaterThan(0.5);
    expect(lamp(ROOM).on).not.toBe(true);
    expect(lamp(after).on).toBe(true);
    expect(mean(covering(after).map((f) => warmth(f.color)))).toBeGreaterThan(mean(covering(ROOM).map((f) => warmth(f.color))));
    expect(proposal.rationale.join(" ")).toMatch(/floor lamp was found unlit/);
  });

  it("leaves the room's structure exactly as the photograph gave it", () => {
    for (const proposal of designs("Give me 3 modern designs.")) {
      const after = applyOperations(ROOM, proposal.operations);
      expect(after.objects.map((o) => [o.id, o.transform, o.dimensions, o.support])).toEqual(ROOM.objects.map((o) => [o.id, o.transform, o.dimensions, o.support]));
      expect(after.room).toEqual(ROOM.room);
      expect(after.openings).toEqual(ROOM.openings);
      expect(after.relationships).toEqual(ROOM.relationships);
      expect(after.surfaces.map((s) => ({ ...s, materialId: "" }))).toEqual(ROOM.surfaces.map((s) => ({ ...s, materialId: "" })));
      // The television's screen and the glazed door are nobody's palette.
      expect(findById(after.objects, "television-0")!.materials).toEqual(findById(ROOM.objects, "television-0")!.materials);
    }
  });

  it("says so rather than proposing nothing, when the room already reads that way", () => {
    // MINIMAL_NEUTRAL keeps a ceramic floor, so applied twice it has nothing left to do.
    const [minimal] = designs("a minimal neutral design");
    const after = applyOperations(ROOM, minimal.operations);
    const again = generateProposals(after, intentOf("a minimal neutral design"));
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already reads that way/);
    expect(again.rejected.map((r) => r.title)).toEqual(["Minimal Pale"]);
  });

  it("is deterministic on the real room, byte for byte", () => {
    for (const text of ["Give me 3 modern designs.", "Give me a cozy design.", "Make this room feel warmer and more luxurious.", "give me 3 designs"]) {
      const a = generateProposals(realRoom(), intentOf(text));
      const b = generateProposals(realRoom(), intentOf(text));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe("the workspace, designing the real room", () => {
  const store = () => new WorkspaceStore(ROOM, "download.png", createRoomInterpreter(ROOM), ROOM.materials);

  it("asks, previews without touching the document, and gives the room back exactly on exit", async () => {
    const s = store();
    await s.run("Give me 3 modern designs.", signal());
    const session = s.getState().design!;
    expect(session.proposals).toHaveLength(3);
    expect(session.previewId).toBeNull();
    expect(s.getState().scene).toBe(ROOM);

    s.previewDesign(session.proposals[0].id);
    // The renderer sees the design; the document does not.
    expect(s.getState().scene).not.toBe(ROOM);
    expect(s.getState().scene).toStrictEqual(applyOperations(ROOM, session.proposals[0].operations));
    expect(s.getState().doc.scene).toBe(ROOM);
    expect(s.getState().doc.past).toHaveLength(0);
    expect(s.getState().design!.proposals.map((p) => p.status)).toEqual(["preview", "draft", "draft"]);

    s.exitDesignPreview();
    // The very same Scene, not an equal one — and equal to the last byte.
    expect(s.getState().scene).toBe(ROOM);
    expect(JSON.stringify(s.getState().scene)).toBe(JSON.stringify(ROOM));
    expect(s.getState().design!.proposals.every((p) => p.status === "draft")).toBe(true);
  });

  it("drops a design preview when a command takes the room, and leaves nothing stale behind", async () => {
    const s = store();
    await s.run("Give me 3 modern designs.", signal());
    const first = s.getState().design!.proposals[0];
    s.previewDesign(first.id);
    expect(s.getState().scene).not.toBe(ROOM);

    // A command's own changes are what the room shows now; the design is let go.
    await s.run("Make the sofa darker", signal());
    expect(s.getState().design!.previewId).toBeNull();
    expect(s.getState().design!.proposals.every((p) => p.status === "draft")).toBe(true);
    expect(s.getState().proposal?.title).toBe("Make sofa darker");
    expect(s.getState().scene).toStrictEqual(applyOperations(ROOM, s.getState().proposal!.changes.flatMap((c) => c.operations)));

    // Applying it leaves the document changed and no preview of anything.
    s.acceptProposal();
    expect(s.getState().proposal).toBeNull();
    expect(s.getState().design!.previewId).toBeNull();
    expect(s.getState().scene).toBe(s.getState().doc.scene);
    expect(s.getState().doc.past).toHaveLength(1);

    // And undoing through the history clears a preview rather than leaving it over an older room.
    s.previewDesign(first.id);
    s.undo();
    expect(s.getState().design!.previewId).toBeNull();
    expect(s.getState().scene).toBe(s.getState().doc.scene);
    expect(s.getState().doc.scene).toStrictEqual(ROOM);
  });

  it("applies a design as one step in the history, and undoes and redoes it in one", async () => {
    const s = store();
    await s.run("Give me a cozy design.", signal());
    const proposal = s.getState().design!.proposals[0];
    const designed = applyOperations(ROOM, proposal.operations);

    s.previewDesign(proposal.id);
    s.applyDesign(proposal.id);
    expect(s.getState().doc.scene).toStrictEqual(designed);
    expect(s.getState().doc.past).toHaveLength(1);
    expect(s.getState().doc.past[0].label).toBe("Cozy Amber");
    expect(s.getState().design!.appliedId).toBe(proposal.id);
    expect(s.getState().design!.proposals[0].status).toBe("applied");
    expect(s.getState().receipt).toMatchObject({ title: "Cozy Amber", changes: proposal.preview.operationCount });

    s.undo();
    expect(s.getState().doc.scene).toStrictEqual(ROOM);
    expect(s.getState().scene).toStrictEqual(ROOM);
    s.redo();
    expect(s.getState().doc.scene).toStrictEqual(designed);
    s.undo();
    expect(s.getState().doc.scene).toStrictEqual(ROOM);
  });

  it("takes a design by its place on screen, and says so when there is no such one", async () => {
    const s = store();
    await s.run("Give me 3 modern designs.", signal());
    const second = s.getState().design!.proposals[1];

    await s.run("preview the second design", signal());
    expect(s.getState().design!.previewId).toBe(second.id);
    await s.run("apply the second design", signal());
    expect(s.getState().doc.past.map((e) => e.label)).toEqual(["Modern Neutral"]);

    await s.run("apply design 9", signal());
    expect(s.getState().command.note).toMatch(/There are 3 designs on screen/);
    // Nothing was applied by that, and the history still holds one step.
    expect(s.getState().doc.past).toHaveLength(1);
    await s.run("close the designs", signal());
    expect(s.getState().design).toBeNull();
    // With none on screen, an act on them is answered rather than quietly making some.
    await s.run("apply the second design", signal());
    expect(s.getState().command.note).toMatch(/no designs on screen/);
  });

  it("keeps designs and edit commands apart, and lets both work on the same room", async () => {
    const s = store();
    // An edit command is still an edit command, with designs on screen.
    await s.run("Give me 3 modern designs.", signal());
    await s.run("Make the room warmer", signal());
    expect(s.getState().proposal?.title).toBe("Make the room warmer");
    expect(s.getState().design!.proposals).toHaveLength(3);
    s.acceptProposal();
    expect(s.getState().doc.past.map((e) => e.label)).toEqual(["Make the room warmer"]);

    // And a design generated afterwards is generated against the room as it now is.
    await s.run("Give me a Scandinavian design.", signal());
    const proposal = s.getState().design!.proposals[0];
    expect(validateOperations(s.getState().doc.scene, proposal.operations)).toEqual({ ok: true });
    s.applyDesign(proposal.id);
    expect(s.getState().doc.past.map((e) => e.label)).toEqual(["Make the room warmer", "Scandinavian Light"]);
    s.undo();
    s.undo();
    expect(s.getState().doc.scene).toStrictEqual(ROOM);
  });

  it("answers plainly when the words are not a design request it can read", async () => {
    const s = store();
    await s.run("give me a brutalist concrete bunker vibe", signal());
    // Read as a design request; the style vocabulary has no brutalism, so it
    // answers with the styles it does have rather than inventing one.
    expect(s.getState().design).not.toBeNull();
    expect(s.getState().design!.proposals.length).toBeGreaterThan(0);
  });
});
