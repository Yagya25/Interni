import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { applyOperations, type SceneOperation } from "@/scene/model/operations";
import { findById } from "@/scene/model/queries";
import type { Id, Scene, SceneObject } from "@/scene/model/types";
import { createRoomInterpreter } from "../../ai/roomInterpreter";
import { collision, footprintOf, separation } from "../../ai/rules/spatial";
import { WorkspaceStore } from "../../state/store";
import { analyseScene } from "../analysis";
import { generateProposals } from "../generate";
import { validateDesignIntent, type DesignIntent } from "../intent";
import type { DesignProposal } from "../proposal";
import { readBrief } from "../read";
import { validateOperations } from "../validate";
import { circulationOf } from "./circulation";
import { angleOf, relationsOf, turnBetween } from "./geometry";
import { spatialRoles } from "./roles";

/**
 * Layouts for the room in the photograph.
 *
 * The real worker output for download.png, compiled exactly as the browser
 * compiles it: a sofa against the left wall facing a wall-hung television,
 * a coffee table between them, two armchairs and a chair, an ottoman, a
 * floor lamp, a bookshelf and a media console — and one armchair standing
 * in front of the glazed door. Nothing below names a coordinate of this
 * room: every expectation is read from the room's own geometry.
 */
const FIXTURE = new URL("../../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);

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
const layouts = (text: string, scene: Scene = ROOM) => {
  const result = generateProposals(scene, intentOf(text));
  if (!result.ok) throw new Error(result.reason);
  return result.proposals;
};
const moves = (p: DesignProposal) => p.operations.filter((op): op is Extract<SceneOperation, { kind: "move" }> => op.kind === "move");
const moved = (p: DesignProposal) => new Set(moves(p).map((op) => op.objectId));
const object = (scene: Scene, id: Id) => findById(scene.objects, id)!;
const centre = (o: SceneObject): [number, number] => [o.transform.position[0], o.transform.position[2]];
/** How far a piece's front is turned away from a point, in degrees. */
const offFrom = (o: SceneObject, point: [number, number]) => (turnBetween(o.transform.rotation[1], angleOf([point[0] - centre(o)[0], point[1] - centre(o)[1]])) * 180) / Math.PI;
const SEATS = ["sofa-0", "armchair-0", "armchair-1", "chair-0"];
const TV = centre(object(ROOM, "television-0"));
const TABLE = centre(object(ROOM, "coffee-table-0"));

/** Every piece a plan moves: inside the room, through nothing, a clear gap from every other piece. */
function physicallyValid(scene: Scene, p: DesignProposal) {
  const after = applyOperations(scene, p.operations);
  for (const id of moved(p)) {
    const o = object(after, id);
    expect(collision(after, o, footprintOf(o)), `${id} runs into something`).toBeNull();
    for (const other of after.objects) {
      if (other.id === id || other.support.kind !== "floor" || other.dimensions[1] <= 0.05) continue;
      expect(separation(footprintOf(o), footprintOf(other)), `${id} is jammed against ${other.id}`).toBeGreaterThanOrEqual(0.049);
    }
  }
  return after;
}

describe("three furniture layouts for the real room", () => {
  const proposals = layouts("Give me three furniture layouts.");

  it("gives three layouts named from the room itself, each a different arrangement", () => {
    expect(proposals.map((p) => p.title)).toEqual(["Around the television", "Conversation around the coffee table", "Open floor"]);
    expect(proposals.map((p) => p.layout?.style)).toEqual(["TV_FOCUSED", "CONVERSATION", "OPEN"]);
    // Materially different: not the same moves under three titles.
    expect(new Set(proposals.map((p) => JSON.stringify(moves(p)))).size).toBe(3);
    const poses = proposals.map((p) => JSON.stringify(applyOperations(ROOM, p.operations).objects.map((o) => o.transform)));
    expect(new Set(poses).size).toBe(3);
  });

  it("moves furniture and nothing else, and only what may move", () => {
    const roles = new Map(spatialRoles(ROOM).map((r) => [r.id, r]));
    for (const p of proposals) {
      expect(p.style).toBeNull();
      expect(p.operations.every((op) => op.kind === "move")).toBe(true);
      expect(validateOperations(ROOM, p.operations)).toEqual({ ok: true });
      for (const id of moved(p)) expect(roles.get(id)!.mobility).toBe("movable");
      physicallyValid(ROOM, p);
      // Finishes, light, surfaces and openings untouched.
      const after = applyOperations(ROOM, p.operations);
      expect(after.materials).toBe(ROOM.materials);
      expect(after.lights).toBe(ROOM.lights);
      expect(after.surfaces).toBe(ROOM.surfaces);
      expect(after.openings).toBe(ROOM.openings);
      expect(after.room).toBe(ROOM.room);
    }
  });

  it("changes only what each direction needs", () => {
    for (const p of proposals) {
      expect(moved(p).size).toBeGreaterThan(0);
      expect(moved(p).size).toBeLessThanOrEqual(3);
      // The sofa already faces the television across the room; no direction here needs it moved.
      expect(moved(p).has("sofa-0")).toBe(false);
      expect(p.preview.movedObjectCount).toBe(moved(p).size);
    }
  });

  it("says what each piece does, and what it leaves alone", () => {
    const [tv] = proposals;
    expect(tv.changes.map((c) => c.group)).toEqual(tv.changes.map(() => "Layout"));
    expect(tv.changes.find((c) => c.target === "Chair")!.detail).toMatch(/to face the television/);
    expect(tv.rationale.join(" ")).toMatch(/The sofa already faces the television/);
    expect(tv.constraints).toContain("Only furniture moves: finishes and light are left exactly as they are");
    expect(tv.constraints).toContain("Wall-hung pieces stay on their walls: 4 artworks, 2 curtains and the television");
    expect(tv.constraints).toContain("The bookshelf stays where it is: it is storage standing against the far wall");
    expect(tv.constraints).toContain("The media console stays where it is: the television hangs above it");
    expect(tv.constraints.join(" ")).toMatch(/not an accessibility assessment/);
    // No layout is scored or ranked for the person.
    expect(JSON.stringify(proposals)).not.toMatch(/"score"|best layout/i);
  });
});

describe("what each layout does to the real room", () => {
  it("makes the seating more social: seats turned in round the table, and the relationships show it", () => {
    const [p] = layouts("Make the seating more social.");
    expect(p.layout?.style).toBe("CONVERSATION");
    const after = physicallyValid(ROOM, p);
    for (const id of moved(p)) {
      if (!SEATS.includes(id)) continue;
      // Each moved seat faces the group's centre, and was not doing so before.
      expect(offFrom(object(after, id), TABLE)).toBeLessThan(offFrom(object(ROOM, id), TABLE));
    }
    expect(offFrom(object(after, "armchair-0"), TABLE)).toBeLessThan(15);
    // Recomputed by the compiler's own rules: the table now stands in front of an armchair it did not before.
    const has = (scene: Scene, s: Id, pred: string, o: Id) => relationsOf(scene).some((r) => r.subjectId === s && r.predicate === pred && r.objectId === o);
    expect(has(ROOM, "coffee-table-0", "in-front-of", "armchair-0")).toBe(false);
    expect(has(after, "coffee-table-0", "in-front-of", "armchair-0")).toBe(true);
    expect(p.layout!.relationships.gained.join(" ")).toMatch(/coffee table stands in front of the armchair 1/);
    // And the table keeps its place in front of the sofa.
    expect(has(after, "coffee-table-0", "in-front-of", "sofa-0")).toBe(true);
  });

  it("arranges the room around the television: every seat it touches turns to the screen", () => {
    const [p] = layouts("Arrange the room around the TV.");
    expect(p.title).toBe("Around the television");
    const after = physicallyValid(ROOM, p);
    expect(moved(p).size).toBeGreaterThan(0);
    for (const id of moved(p)) expect(offFrom(object(after, id), TV)).toBeLessThan(15);
    // Taken together the seating faces the screen more squarely than before.
    const total = (scene: Scene) => SEATS.reduce((sum, id) => sum + offFrom(object(scene, id), TV), 0);
    expect(total(after)).toBeLessThan(total(ROOM) - 90);
    // The sofa keeps facing it, by the rules the compiler recorded that with.
    expect(relationsOf(after)).toContainEqual(expect.objectContaining({ subjectId: "sofa-0", predicate: "faces", objectId: "television-0" }));
  });

  it("makes the room more open: more walkable floor, and the glazed door cleared", () => {
    const [p] = layouts("Make the room more open.");
    expect(p.layout?.style).toBe("OPEN");
    const after = physicallyValid(ROOM, p);
    const before = circulationOf(ROOM);
    const now = circulationOf(after);
    expect(before.passages[0].blockedBy).toEqual(["armchair-1"]);
    expect(now.passages[0].blockedBy).toEqual([]);
    expect(now.walkableArea).toBeGreaterThan(before.walkableArea + 1);
    expect(now.seats.every((s) => s.reachable)).toBe(true);
    expect(p.rationale.join(" ")).toMatch(/no longer stands in front of the glazed door/);
  });

  it("creates a cozy conversation layout: the close reading, seats drawn in, with room to sit", () => {
    const [p] = layouts("Create a cozy conversation layout.");
    expect(p.title).toBe("Close conversation");
    expect(p.style).toBeNull();
    const after = physicallyValid(ROOM, p);
    const distance = (scene: Scene, id: Id) => Math.hypot(centre(object(scene, id))[0] - TABLE[0], centre(object(scene, id))[1] - TABLE[1]);
    for (const id of moved(p)) {
      expect(distance(after, id)).toBeLessThan(distance(ROOM, id));
      expect(offFrom(object(after, id), TABLE)).toBeLessThan(offFrom(object(ROOM, id), TABLE) + 1);
    }
  });

  it("reads a finish style and a layout together as one proposal", () => {
    const [p] = layouts("Give me a modern cozy design with a conversation layout");
    expect(p.title).toBe("Conversation around the coffee table · Cozy Amber");
    expect(p.style).toBe("COZY");
    const kinds = new Set(p.operations.map((op) => op.kind));
    expect([...kinds].sort()).toEqual(["move", "relight", "restyle", "resurface"]);
    // The moves come first, then the finishes: one list, as a drag and a repaint would be.
    expect(p.operations[0].kind).toBe("move");
    expect(p.constraints).toContain("No furniture is added or taken away");
    expect(p.constraints).not.toContain("No furniture is moved, added or taken away");
    expect(validateOperations(ROOM, p.operations)).toEqual({ ok: true });
  });

  it("moves a piece out of the way deterministically when another takes its place", () => {
    // Centring the sofa on the screen slides it over where the floor lamp stood.
    const tv = generateProposals(ROOM, intentOf("give me three layouts around the tv")).proposals;
    const centred = tv.find((p) => p.title === "Centred on the television")!;
    expect(moved(centred).has("sofa-0")).toBe(true);
    expect(moved(centred).has("floor-lamp-0")).toBe(true);
    const after = physicallyValid(ROOM, centred);
    // The lamp is not left where the sofa now is.
    const lampWas = footprintOf(object(ROOM, "floor-lamp-0"));
    expect(separation(footprintOf(object(after, "sofa-0")), lampWas)).toBeLessThan(0);
    // The sofa's centre is now on the television's axis.
    expect(Math.abs(centre(object(after, "sofa-0"))[1] - TV[1])).toBeLessThan(0.1);
  });
});

describe("the hard constraints, on the real room", () => {
  const move =(id: Id, to: [number, number], turn?: number): SceneOperation => {
    const o = object(ROOM, id);
    return { kind: "move", objectId: id, to: [to[0], o.transform.position[1], to[1]], rotationY: turn ?? o.transform.rotation[1] };
  };

  it("refuses a piece that would leave the room", () => {
    expect(validateOperations(ROOM, [move("armchair-0", [5, 0])])).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the room/) });
  });

  it("refuses a piece that would run into another", () => {
    expect(validateOperations(ROOM, [move("armchair-0", TABLE)])).toMatchObject({ ok: false, reason: expect.stringMatching(/run into the coffee table/) });
  });

  it("refuses a piece that would stand in the doorway", () => {
    // Clear of every piece, but standing in front of the glazed door where it stood nowhere near it before.
    expect(validateOperations(ROOM, [move("chair-0", [0.7, -2.75], Math.PI / 2)])).toMatchObject({ ok: false, reason: expect.stringMatching(/would stand in the way of the glazed door/) });
  });

  it("refuses a move that would shut a seat in", () => {
    // The chair set in the one 60 cm gap between the far armchair and the console: the path from the
    // glazed door to the rest of the room is cut, and the other armchair can no longer be reached.
    expect(validateOperations(ROOM, [move("chair-0", [0.65, -1.95], Math.PI / 2)])).toMatchObject({ ok: false, reason: "the armchair 1 would be shut in, with no way to reach it" });
  });

  it("never treats a wall-hung piece as floor furniture", () => {
    expect(validateOperations(ROOM, [move("television-0", [0, 0])])).toMatchObject({ ok: false, reason: expect.stringMatching(/hangs on a wall/) });
    expect(validateOperations(ROOM, [move("artwork-1", [-1.842, -1.0])])).toMatchObject({ ok: false, reason: expect.stringMatching(/hangs on a wall/) });
    const roles = spatialRoles(ROOM);
    for (const id of ["television-0", "artwork-0", "artwork-1", "artwork-2", "artwork-3", "curtain-0", "curtain-1"]) {
      expect(roles.find((r) => r.id === id)!.mobility).toBe("wall-mounted");
    }
  });

  it("never moves the room itself, or what is anchored in it", () => {
    expect(validateOperations(ROOM, [move("bookshelf-0", [0, 1])])).toMatchObject({ ok: false, reason: "the bookshelf stays where it is: it is storage standing against the far wall" });
    expect(validateOperations(ROOM, [move("media-console-0", [0, 1], 0)])).toMatchObject({ ok: false, reason: "the media console stays where it is: the television hangs above it" });
    const roles = spatialRoles(ROOM);
    for (const id of ["wall-far", "wall-left", "wall-right", "floor", "ceiling", "window-0"]) expect(roles.find((r) => r.id === id)!.mobility).toBe("structural");
    // Across every direction the planner offers, nothing structural or anchored is ever moved.
    const all = [
      ...layouts("Give me three furniture layouts."),
      ...generateProposals(ROOM, intentOf("give me three layouts around the tv")).proposals,
      ...generateProposals(ROOM, intentOf("give me three conversation layouts")).proposals,
      ...generateProposals(ROOM, intentOf("give me three open layouts")).proposals,
    ];
    expect(all.length).toBe(12);
    for (const p of all) {
      for (const id of moved(p)) expect(["bookshelf-0", "media-console-0", "television-0", "curtain-0", "curtain-1"]).not.toContain(id);
      const after = applyOperations(ROOM, p.operations);
      expect(after.surfaces).toBe(ROOM.surfaces);
      expect(after.openings).toBe(ROOM.openings);
    }
  });

  it("rejects a layout that cannot be made before it is ever shown, and says why", () => {
    // Asked of the room once everything movable already stands at a wall, every open reading is refused.
    const [pared] = layouts("Give me a more minimal furniture arrangement.");
    expect(pared.title).toBe("Pared back to the walls");
    const opened = applyOperations(ROOM, pared.operations);
    const again = generateProposals(opened, intentOf("Make the room more open."));
    expect(again.ok).toBe(false);
    expect(again.proposals).toEqual([]);
    expect(again.rejected.map((r) => r.title)).toEqual(["Open floor", "Clear way to the glazed door", "Pared back to the walls"]);
    expect(again.reason).toBe("I couldn’t rearrange this room that way — the room already reads that way: nothing would need to move.");
  });
});

describe("determinism", () => {
  it("gives byte-identical layouts for the same room and request", { timeout: 60000 }, () => {
    for (const text of ["Give me three furniture layouts.", "Make the seating more social.", "Arrange the room around the TV.", "Make the room more open.", "Create a cozy conversation layout."]) {
      const a = generateProposals(realRoom(), intentOf(text));
      const b = generateProposals(realRoom(), intentOf(text));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it("reads the room's relationships exactly as the compiler recorded them", () => {
    expect(relationsOf(ROOM)).toEqual(ROOM.relationships);
    expect(analyseScene(ROOM).layout.staleRelationships).toEqual([]);
  });
});

describe("the workspace, arranging the real room", () => {
  const store = () => new WorkspaceStore(ROOM, "download.png", createRoomInterpreter(ROOM), ROOM.materials);

  it("previews a layout without touching the document, and gives the exact room back on exit", async () => {
    const s = store();
    await s.run("Give me three furniture layouts.", signal());
    const session = s.getState().design!;
    expect(session.proposals).toHaveLength(3);
    s.previewDesign(session.proposals[0].id);
    // The furniture the renderer draws has moved; the document's has not.
    expect(s.getState().scene).toStrictEqual(applyOperations(ROOM, session.proposals[0].operations));
    expect(s.getState().scene.objects).not.toEqual(ROOM.objects);
    expect(s.getState().doc.scene).toBe(ROOM);
    expect(s.getState().doc.past).toHaveLength(0);

    s.exitDesignPreview();
    expect(s.getState().scene).toBe(ROOM);
    expect(JSON.stringify(s.getState().scene)).toBe(JSON.stringify(ROOM));
  });

  it("applies a layout as one history step, and undoes and redoes it exactly", async () => {
    const s = store();
    await s.run("Give me three furniture layouts.", signal());
    const second = s.getState().design!.proposals[1];
    const arranged = applyOperations(ROOM, second.operations);
    s.previewDesign(second.id);
    s.applyDesign(second.id);
    expect(s.getState().doc.past).toHaveLength(1);
    expect(s.getState().doc.past[0].label).toBe("Conversation around the coffee table");
    expect(s.getState().doc.scene).toStrictEqual(arranged);
    expect(s.getState().scene).toStrictEqual(arranged);

    s.undo();
    expect(s.getState().doc.scene).toStrictEqual(ROOM);
    expect(JSON.stringify(s.getState().doc.scene)).toBe(JSON.stringify(ROOM));
    s.redo();
    expect(s.getState().doc.scene).toStrictEqual(arranged);
    expect(JSON.stringify(s.getState().doc.scene)).toBe(JSON.stringify(arranged));
  });

  it("takes a layout by its place on screen", async () => {
    const s = store();
    await s.run("Give me three furniture layouts.", signal());
    await s.run("preview the third layout", signal());
    expect(s.getState().design!.previewId).toBe(s.getState().design!.proposals[2].id);
    await s.run("apply layout 3", signal());
    expect(s.getState().doc.past.map((e) => e.label)).toEqual(["Open floor"]);
  });

  it("keeps direct commands direct, and their ambiguity handling, with layouts on screen", async () => {
    const s = store();
    await s.run("Give me three furniture layouts.", signal());
    const layoutsOnScreen = s.getState().design;
    // "Left" as the photograph shows the room: the sofa already stands against the left wall.
    // Read and resolved as a command, and answered as one — not turned into a layout.
    await s.run("Move the sofa 20cm left", signal());
    expect(s.getState().command.note).toMatch(/can’t move left.*the wall is in the way/);
    expect(s.getState().design).toBe(layoutsOnScreen);
    await s.run("Move the sofa forward 20 cm", signal());
    expect(s.getState().proposal?.changes[0].group).toBe("Furniture");
    expect(s.getState().proposal?.changes[0].detail).toMatch(/^moved 20 cm forward/);
    expect(s.getState().design!.proposals).toHaveLength(3);
    s.acceptProposal();
    expect(s.getState().doc.past.map((e) => e.label)).toEqual(["Move sofa forward 20 cm"]);
    s.undo();

    await s.run("Move the chair", signal());
    expect(s.getState().command.kind).toBe("ambiguous");
    expect(s.getState().command.options.length).toBeGreaterThan(1);
    expect(s.getState().doc.past).toHaveLength(0);
  });

  it("says so, rather than making something up, when a layout cannot be made", async () => {
    const s = store();
    await s.run("Give me a more minimal furniture arrangement.", signal());
    s.applyDesign(s.getState().design!.proposals[0].id);
    await s.run("Make the room more open.", signal());
    expect(s.getState().command.note).toMatch(/^I couldn’t rearrange this room that way — /);
    expect(s.getState().doc.past).toHaveLength(1);
  });
});
