import { describe, expect, it } from "vitest";
import { demo } from "@/demo";
import { commit, createDocument, redo, undo } from "@/features/workspace/state/document";
import { syntheticInstances, syntheticIntermediate } from "@/scene/compile/__fixtures__/synthetic";
import { compileRoomShell } from "@/scene/compile/compileRoomShell";
import { applyOperation, applyOperations } from "@/scene/model/operations";
import { findById, objectCenter, openingCenter } from "@/scene/model/queries";
import type { Scene, SceneObject } from "@/scene/model/types";
import { validateIntent, type SceneIntent } from "../intent";
import type { InterpretationResult } from "../interpreter";
import { CATEGORIES, createRoomInterpreter } from "../roomInterpreter";
import { compileIntent } from "./compile";
import { read } from "./read";
import { collision, footprintOf, insideRoom, separation } from "./spatial";

// ---------------------------------------------------------------------------
// Rooms: the demonstration room, and a room the SceneCompiler reconstructed
// from synthetic observations, with a TV console added below the TV (as the
// reconstruction would, against the same wall).

function reconstructedRoom(): Scene {
  const compiled = compileRoomShell(syntheticIntermediate({}, syntheticInstances));
  if (!compiled.ok) throw new Error(compiled.problem.code);
  const scene = compiled.scene;
  const tv = scene.objects.find((o) => o.category === "television")!;
  const console: SceneObject = {
    id: "media-console-0",
    category: "media-console",
    label: "Media console",
    transform: { position: [tv.transform.position[0] + 0.4, 0, tv.transform.position[2] + 0.2], rotation: tv.transform.rotation, scale: [1, 1, 1] },
    dimensions: [1.4, 0.5, 0.4],
    materials: { body: scene.objects.find((o) => o.category === "coffee-table")!.materials.top },
    support: { kind: "floor" },
  };
  return applyOperation(scene, {
    kind: "add",
    object: console,
    index: scene.objects.length,
    relationships: [{ relationship: { id: "rel-console-wall", subjectId: console.id, predicate: "against", objectId: "wall-far" }, index: scene.relationships.length }],
  });
}

const ROOM = reconstructedRoom();
const categories = CATEGORIES;

function run(scene: Scene, text: string, selectionId: string | null = null): InterpretationResult {
  const intent = read(text);
  if (!intent) return { outcome: "unsupported", message: "not read" };
  const checked = validateIntent(JSON.parse(JSON.stringify(intent)), categories);
  if (!checked.ok) throw new Error(checked.reason);
  return compileIntent(checked.intent, { scene, original: scene, selectionId }, text);
}

function applied(scene: Scene, result: InterpretationResult): Scene {
  if (result.outcome !== "changes") throw new Error(`expected changes, got ${result.outcome}: ${"message" in result ? result.message : ""}`);
  return applyOperations(scene, result.interpretation.changes.flatMap((c) => c.operations));
}

const obj = (scene: Scene, category: string) => scene.objects.find((o) => o.category === category)!;
const flat = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);

// ---------------------------------------------------------------------------

describe("reading a command into a strict intent", () => {
  it("reads each kind of edit into its own shape", () => {
    expect(read("Move the sofa closer to the window")).toMatchObject({ type: "move_object", target: { kind: "object", categories: ["sofa"] }, destination: { kind: "relative", relation: "closer_to", reference: { kind: "opening", opening: "window" } }, distance: null });
    expect(read("Rotate the sofa 20 degrees")).toMatchObject({ type: "rotate_object", degrees: 20, face: null });
    expect(read("rotate the couch anticlockwise by 30")).toMatchObject({ type: "rotate_object", degrees: -30, target: { aliasOf: ["sofa"] } });
    expect(read("Make the sofa slightly larger")).toMatchObject({ type: "scale_object", factor: 1.08 });
    expect(read("Remove the plant")).toMatchObject({ type: "remove_object", target: { categories: ["plant"] } });
    expect(read("Make the sofa darker")).toMatchObject({ type: "change_material", change: { kind: "tone", tone: "darker" } });
    expect(read("Change the curtains to white")).toMatchObject({ type: "change_material", target: { categories: ["curtain"], plural: true }, change: { kind: "colour", name: "white" } });
    expect(read("Make the room warmer")).toMatchObject({ type: "change_lighting", scope: { kind: "room" }, change: "warmer", includeSurfaces: true });
    expect(read("make the lighting warmer")).toMatchObject({ type: "change_lighting", scope: { kind: "room" }, includeSurfaces: false });
    expect(read("Move the TV above the console")).toMatchObject({ type: "move_object", target: { categories: ["television"] }, destination: { relation: "above", reference: { aliasOf: ["media-console"] } } });
    expect(read("Move the floor lamp beside the sofa")).toMatchObject({ type: "move_object", destination: { relation: "beside" }, target: { categories: ["floor-lamp"] } });
    expect(read("make the coffee table glass")).toMatchObject({ type: "change_material", change: { kind: "class", material: "glass" } });
    expect(read("reset the room")).toEqual({ type: "reset_room" });
  });

  it("keeps qualifiers: a relationship, a side, a number, a pointer", () => {
    expect(read("make the lamp beside the sofa warmer")).toMatchObject({ type: "change_lighting", scope: { kind: "object", near: { predicate: "beside", of: { kind: "object", categories: ["sofa"] } } } });
    expect(read("move the left curtain closer to the window")).toMatchObject({ target: { sides: ["left"] } });
    expect(read("move the front-right chair left")).toMatchObject({ target: { sides: ["right", "front"] }, destination: { kind: "direction", direction: "left" } });
    expect(read("move the chair near the window left")).toMatchObject({ target: { near: { predicate: "near", of: { kind: "opening" } } } });
    expect(read("rotate armchair 2 by 15 degrees")).toMatchObject({ degrees: 15, target: { ordinal: 2 } });
    expect(read("make that chair darker")).toMatchObject({ target: { pointed: true } });
    expect(read("make the spaceship darker")).toMatchObject({ target: { kind: "object", words: "spaceship", categories: [], aliasOf: [] } });
  });

  it("returns nothing for words that are not an edit", () => {
    expect(read("what a lovely day")).toBeNull();
  });
});

describe("the provider boundary", () => {
  it("accepts what the reader writes, and refuses anything off-schema", () => {
    const good = read("Move the sofa closer to the window") as SceneIntent;
    expect(validateIntent(JSON.parse(JSON.stringify(good)), categories)).toEqual({ ok: true, intent: good });
    expect(validateIntent({ type: "teleport" }, categories)).toMatchObject({ ok: false, reason: expect.stringContaining("type") });
    expect(validateIntent({ ...good, destination: { kind: "relative", relation: "teleport", reference: { kind: "room" } } }, categories)).toMatchObject({ ok: false, reason: expect.stringContaining("relation") });
    expect(validateIntent({ ...good, distance: -1 }, categories)).toMatchObject({ ok: false, reason: expect.stringContaining("distance") });
    expect(validateIntent({ type: "rotate_object", target: { kind: "selection" }, degrees: 20, face: { kind: "room" } }, categories)).toMatchObject({ ok: false });
    expect(validateIntent({ type: "rotate_object", target: { kind: "selection" }, degrees: Number.NaN, face: null }, categories)).toMatchObject({ ok: false });
    expect(validateIntent({ type: "remove_object", target: { kind: "object", words: "x", categories: ["spaceship"], aliasOf: [], pointed: false, plural: false, sides: [], ordinal: null, near: null } }, categories)).toMatchObject({ ok: false, reason: expect.stringContaining("categories") });
    expect(validateIntent({ type: "remove_object", target: { kind: "object", words: "chair", categories: ["chair"], aliasOf: [], pointed: false, plural: false, sides: ["left", "right"], ordinal: null, near: null } }, categories)).toMatchObject({ ok: false, reason: expect.stringContaining("sides") });
  });
});

describe("resolving what a command is about", () => {
  it("finds pieces by their own name, then by alias", () => {
    expect(run(ROOM, "make the couch darker")).toMatchObject({ outcome: "changes" });
    expect(run(ROOM, "make the tv darker")).toMatchObject({ outcome: "changes", interpretation: { summary: expect.stringContaining("Television") } });
    // "cabinet": no cabinet here, so the TV console, which a cabinet also means.
    expect(run(ROOM, "make the cabinet darker")).toMatchObject({ outcome: "changes", interpretation: { summary: expect.stringContaining("Media console") } });
  });

  it("asks rather than guesses when two pieces fit, and takes the selected one", () => {
    const table = run(demo.scene, "make the table darker");
    expect(table).toMatchObject({ outcome: "clarify", message: "I found 2 tables. Which one do you mean?", clarification: { reason: "ambiguous" } });
    const options = table.outcome === "clarify" && table.clarification.reason === "ambiguous" ? table.clarification.options : [];
    expect(options.map((o) => o.id).sort()).toEqual(["coffee-table", "side-table"]);
    expect(run(demo.scene, "make the table darker", "side-table")).toMatchObject({ outcome: "changes", interpretation: { summary: expect.stringContaining("Side table") } });
    expect(run(demo.scene, "make that table darker", "coffee-table")).toMatchObject({ outcome: "changes", interpretation: { summary: expect.stringContaining("Coffee table") } });
  });

  it("narrows by a relationship the scene holds", () => {
    // The demo's floor lamp and side table are both "beside" the sofa; its pendant is above the coffee table.
    const lamp = run(demo.scene, "switch on the lamp above the coffee table");
    expect(lamp).toMatchObject({ outcome: "changes", interpretation: { changes: [{ operations: [{ kind: "relight", lightId: expect.stringMatching(/pendant/) }] }] } });
  });

  it("says plainly when a thing isn’t there", () => {
    expect(run(ROOM, "move the spaceship next to the sofa")).toMatchObject({ outcome: "unsupported", message: "There’s no spaceship in this room." });
    expect(run(ROOM, "remove the bed")).toMatchObject({ outcome: "unsupported", message: "There’s no bed in this room." });
  });
});

describe("moves worked out from the scene", () => {
  it("moves the sofa closer to the window, along its wall, without passing through anything", () => {
    const sofa = obj(ROOM, "sofa");
    const window = openingCenter(ROOM, ROOM.openings[0]);
    const next = applied(ROOM, run(ROOM, "Move the sofa closer to the window"));
    const moved = findById(next.objects, sofa.id)!;
    expect(flat(moved.transform.position, window)).toBeLessThan(flat(sofa.transform.position, window) - 0.05);
    // It stands against the left wall and stays there: only its position along the wall changes.
    expect(moved.transform.position[0]).toBeCloseTo(sofa.transform.position[0], 3);
    expect(insideRoom(next, footprintOf(moved))).toBe(true);
    // Through nothing: a picture hung above the sofa is passed under, not through.
    expect(collision(next, moved, footprintOf(moved))).toBeNull();
  });

  it("moves the coffee table closer to the sofa, stopping at a comfortable distance, with what stands on it", () => {
    const room = demo.scene;
    const next = applied(room, run(room, "Move the coffee table closer to the sofa"));
    const gap = separation(footprintOf(obj(next, "coffee-table")), footprintOf(obj(next, "sofa")));
    expect(gap).toBeGreaterThanOrEqual(0.29);
    expect(gap).toBeLessThan(separation(footprintOf(obj(room, "coffee-table")), footprintOf(obj(room, "sofa"))) - 0.05);
    const shift = flat(obj(next, "coffee-table").transform.position, obj(room, "coffee-table").transform.position);
    for (const held of ["vase", "books"]) expect(flat(obj(next, held).transform.position, obj(room, held).transform.position)).toBeCloseTo(shift, 3);
    // Where it already stands at that distance, it says so rather than inventing a move.
    const close = run(ROOM, "Move the coffee table closer to the sofa");
    if (close.outcome !== "changes") expect(close).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/already (?:\d+ cm from the sofa, about as close as it comfortably goes \(30 cm\)|only \d+ cm from the sofa, closer than the 30 cm left between pieces for comfort)/) });
  });

  it("sets a lamp beside the sofa and hangs the TV above its console", () => {
    // The demo's lamp stands at the sofa's end already, so that is what is said, and nothing moves.
    expect(run(demo.scene, "Move the floor lamp beside the sofa")).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/already beside the sofa, 2 cm from it/) });
    const away = applied(demo.scene, run(demo.scene, "Move the floor lamp away from the sofa"));
    expect(separation(footprintOf(obj(away, "floor-lamp")), footprintOf(obj(away, "sofa")))).toBeGreaterThan(0.2);
    const lampNext = applied(away, run(away, "Move the floor lamp beside the sofa"));
    const gap = separation(footprintOf(obj(lampNext, "floor-lamp")), footprintOf(obj(lampNext, "sofa")));
    expect(gap).toBeCloseTo(0.1, 2);
    // Asked again, it is already there — it is not carried round to the sofa's other end.
    expect(run(lampNext, "Move the floor lamp beside the sofa")).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/already beside the sofa, 10 cm from it/) });

    const next = applied(ROOM, run(ROOM, "Move the TV above the console"));
    const tv = obj(next, "television");
    const console = obj(next, "media-console");
    expect(tv.transform.position[1]).toBeCloseTo(console.dimensions[1] + 0.15, 3);
    expect(flat(objectCenter(tv), objectCenter(console))).toBeLessThan(0.25); // centred over it, on the wall in front of it
    expect(tv.support).toEqual(obj(ROOM, "television").support);
  });

  it("asks where to when no destination is given, and refuses what can’t be done", () => {
    expect(run(ROOM, "move the sofa")).toMatchObject({ outcome: "clarify", clarification: { reason: "no-reference" } });
    expect(run(ROOM, "move the sofa above the coffee table")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/stands on the floor/) });
  });
});

describe("rotate, resize, remove", () => {
  it("turns clockwise by the angle asked, seen from above, set down clear of everything", () => {
    const room = demo.scene;
    const chair = obj(room, "armchair");
    const result = run(room, "Rotate the armchair 20 degrees");
    const next = applied(room, result);
    const turned = obj(next, "armchair");
    expect(turned.transform.rotation[1] - chair.transform.rotation[1]).toBeCloseTo((-20 * Math.PI) / 180, 6);
    expect(collision(next, turned, footprintOf(turned))).toBeNull();
    expect(insideRoom(next, footprintOf(turned))).toBe(true);
    // The distance the proposal gives is the whole distance the piece travels.
    const said = result.outcome === "changes" ? /moved (\d+) cm/.exec(result.interpretation.changes[0].detail) : null;
    expect(said ? Number(said[1]) : 0).toBe(Math.round(flat(turned.transform.position, chair.transform.position) * 100));
    // Where a turn has no room, it is refused with the largest turn that fits — nothing else is done instead.
    const tight = run(ROOM, "Rotate the sofa 20 degrees");
    expect(tight).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/would push it into the coffee table.*no free spot/) });
    expect(run(ROOM, "rotate the tv 10 degrees")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/off the wall/) });
    expect(run(ROOM, "rotate the sofa 720 degrees")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/full turn/) });
  });

  it("resizes within limits, keeps the piece inside the room, and refuses absurd sizes with the reason", () => {
    const next = applied(ROOM, run(ROOM, "Make the sofa slightly larger"));
    const sofa = obj(next, "sofa");
    expect(sofa.transform.scale).toEqual([1.08, 1.08, 1.08]);
    expect(insideRoom(next, footprintOf(sofa))).toBe(true);
    const absurd = run(ROOM, "make the sofa 5000 times bigger");
    expect(absurd).toMatchObject({ outcome: "unsupported" });
    expect(absurd.outcome === "unsupported" && absurd.message).toMatch(/5000 times bigger would make the sofa .* km wide/);
  });

  it("removes a piece and what it carries, and a lamp takes its light with it", () => {
    const next = applied(ROOM, run(ROOM, "Remove the coffee table"));
    expect(next.objects.some((o) => o.category === "coffee-table" || o.category === "plant")).toBe(false);
    const withoutLamp = applied(demo.scene, run(demo.scene, "remove the floor lamp"));
    expect(withoutLamp.lights.some((l) => l.kind === "artificial" && l.fixtureId === "floor-lamp")).toBe(false);
  });
});

describe("materials and light", () => {
  it("darkens the sofa, and recolours every curtain", () => {
    const next = applied(ROOM, run(ROOM, "Make the sofa darker"));
    const before = findById(ROOM.materials, obj(ROOM, "sofa").materials.upholstery)!.color;
    const after = findById(next.materials, obj(next, "sofa").materials.upholstery)!.color;
    expect(after).not.toBe(before);
    expect(parseInt(after.slice(1, 3), 16)).toBeLessThan(parseInt(before.slice(1, 3), 16));

    const curtains = demo.scene.objects.filter((o) => o.category === "curtain");
    if (curtains.length > 1) {
      const white = applied(demo.scene, run(demo.scene, "Change the curtains to white"));
      for (const c of curtains) expect(findById(white.materials, findById(white.objects, c.id)!.materials.fabric)!.color).toBe("#efeae2");
    }
  });

  it("changes a finish's class where the piece allows it, and refuses where it doesn’t", () => {
    const glass = applied(ROOM, run(ROOM, "make the coffee table glass"));
    const top = findById(glass.materials, obj(glass, "coffee-table").materials.top)!;
    expect(top).toMatchObject({ class: "glass", opacity: 0.4 });
    expect(run(ROOM, "make the sofa glass")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/fabric or leather/) });
  });

  it("warms the room’s light and walls, and refuses a colour for the whole room", () => {
    const result = run(demo.scene, "Make the room warmer");
    expect(result).toMatchObject({ outcome: "changes" });
    const kinds = result.outcome === "changes" ? result.interpretation.changes.flatMap((c) => c.operations.map((o) => o.kind)) : [];
    expect(kinds).toContain("relight");
    expect(kinds).toContain("resurface");
    expect(run(ROOM, "make the room 73% more blue")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/can’t tint the whole room blue by a percentage/) });
  });
});

describe("determinism and history", () => {
  it("compiles the same command on the same scene to the same operations", () => {
    for (const text of ["Move the sofa closer to the window", "Rotate the sofa 20 degrees", "Make the sofa slightly larger", "Make the room warmer", "Move the TV above the console"]) {
      expect(JSON.stringify(run(ROOM, text))).toBe(JSON.stringify(run(ROOM, text)));
    }
  });

  it("goes through the history as one step per command, undoing and redoing exactly", async () => {
    const room = demo.scene;
    const interpreter = createRoomInterpreter(room);
    let doc = createDocument(room, "test");
    const states = [doc.scene];
    for (const text of ["Move the sofa closer to the window", "Rotate the armchair 20 degrees", "Move the coffee table closer to the sofa", "Make the sofa darker", "Make the room warmer", "Remove the plant"]) {
      const result = await interpreter.interpret({ text, subjectId: null, scene: doc.scene }, new AbortController().signal);
      if (result.outcome !== "changes") throw new Error(`${text}: ${result.outcome}`);
      // As the workspace applies a proposal: every change of the command in one entry.
      doc = commit(doc, result.interpretation.changes.flatMap((c) => c.operations), result.interpretation.title);
      states.push(doc.scene);
    }
    expect(doc.past.length).toBe(6);
    // Exactly: the finish a restyle tried leaves the library again, and an hour nobody set is unset again.
    for (let i = states.length - 2; i >= 0; i--) {
      doc = undo(doc);
      expect(doc.scene).toStrictEqual(states[i]);
    }
    for (let i = 1; i < states.length; i++) {
      doc = redo(doc);
      expect(doc.scene).toStrictEqual(states[i]);
    }
  });

  it("undoing a removed lamp brings its light back", () => {
    let doc = createDocument(demo.scene, "demo");
    const result = run(demo.scene, "remove the floor lamp");
    if (result.outcome !== "changes") throw new Error(result.outcome);
    doc = commit(doc, result.interpretation.changes[0].operations, "remove");
    doc = undo(doc);
    expect(doc.scene.lights).toEqual(demo.scene.lights);
    expect(doc.scene.objects).toEqual(demo.scene.objects);
  });
});
