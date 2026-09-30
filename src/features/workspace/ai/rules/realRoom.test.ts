import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commit, createDocument, redo, undo } from "@/features/workspace/state/document";
import { WorkspaceStore } from "@/features/workspace/state/store";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { applyOperations } from "@/scene/model/operations";
import { findById, openingCenter } from "@/scene/model/queries";
import type { Scene } from "@/scene/model/types";
import { validateCommand, type MoveCommand } from "../command";
import type { IntentReader, InterpretationResult } from "../interpreter";
import { CATEGORIES, createRoomInterpreter } from "../roomInterpreter";
import { read } from "./read";
import { collision, footprintOf, holds, insideRoom, wallAgainst } from "./spatial";

/**
 * The room from the photograph the product was tested on (download.png):
 * the worker's real output for it, compiled here exactly as the browser
 * compiles it. Everything below runs against that room, not a demo.
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
const interpreter = createRoomInterpreter(ROOM);
const signal = () => new AbortController().signal;

async function ask(scene: Scene, text: string, subjectId: string | null = null): Promise<InterpretationResult> {
  return interpreter.interpret({ text, subjectId, scene }, signal());
}
function changes(result: InterpretationResult) {
  if (result.outcome !== "changes") throw new Error(`expected changes, got ${result.outcome}: ${"message" in result ? result.message : ""}`);
  return result.interpretation;
}
const apply = (scene: Scene, result: InterpretationResult) => applyOperations(scene, changes(result).changes.flatMap((c) => c.operations));
const piece = (scene: Scene, id: string) => findById(scene.objects, id)!;
const flat = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);

describe("the reconstructed room", () => {
  it("is the room the photograph gave: three chairs, a sofa against the left wall, one glazed door", () => {
    expect(ROOM.provenance.kind).toBe("reconstruction");
    expect(ROOM.objects.filter((o) => ["chair", "armchair"].includes(o.category)).map((o) => o.id).sort()).toEqual(["armchair-0", "armchair-1", "chair-0"]);
    expect(ROOM.relationships).toContainEqual(expect.objectContaining({ subjectId: "sofa-0", predicate: "against", objectId: "wall-left" }));
    expect(ROOM.openings.map((o) => o.label)).toEqual(["Glazed door"]);
  });
});

describe("the eight commands, in order, through the history", () => {
  const COMMANDS = [
    "Move the sofa closer to the window.",
    "Rotate the sofa 20 degrees.",
    "Make the sofa 15% bigger.",
    "Move the coffee table closer to the sofa.",
    "Move the floor lamp beside the sofa.",
    "Make the sofa darker.",
    "Make the room warmer.",
    "Remove the ottoman.",
  ];

  it("changes the real Scene where the room allows it, says why where it doesn't, and undoes and redoes exactly", async () => {
    let doc = createDocument(ROOM, "download.png");
    const states: Scene[] = [ROOM];
    const answers: Record<string, InterpretationResult> = {};
    for (const text of COMMANDS) {
      const result = await ask(doc.scene, text);
      answers[text] = result;
      if (result.outcome !== "changes") continue;
      doc = commit(doc, result.interpretation.changes.flatMap((c) => c.operations), result.interpretation.title);
      states.push(doc.scene);
    }

    // 1. Along its wall towards the glazed door, stopping at the floor lamp; still against the wall, through nothing.
    const moved = states[1];
    const door = openingCenter(ROOM, ROOM.openings[0]);
    expect(changes(answers[COMMANDS[0]]).structured).toEqual({
      type: "MOVE_OBJECT",
      target: { kind: "object", id: "sofa-0" },
      parameters: { direction: "toward", reference: { kind: "opening", id: "window-0" }, distance: null, amount: "normal" },
    });
    expect(flat(piece(moved, "sofa-0").transform.position, door)).toBeLessThan(flat(piece(ROOM, "sofa-0").transform.position, door) - 0.2);
    expect(piece(moved, "sofa-0").transform.position[0]).toBeCloseTo(piece(ROOM, "sofa-0").transform.position[0], 3);
    expect(collision(moved, piece(moved, "sofa-0"), footprintOf(piece(moved, "sofa-0")))).toBeNull();

    // 2. Refused: turning 20° in this room runs into a chair or the table, whichever way it is set down.
    expect(answers[COMMANDS[1]]).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/^Turning the sofa 20° would push it into the .+ It can turn \d+° clockwise here/) });

    // 3. 15% larger, kept inside the room and off its neighbours.
    const bigger = states[2];
    expect(changes(answers[COMMANDS[2]]).structured).toEqual({ type: "SCALE_OBJECT", target: { kind: "object", id: "sofa-0" }, parameters: { factor: 1.15 } });
    expect(piece(bigger, "sofa-0").transform.scale).toEqual([1.15, 1.15, 1.15]);
    expect(insideRoom(bigger, footprintOf(piece(bigger, "sofa-0")))).toBe(true);
    expect(collision(bigger, piece(bigger, "sofa-0"), footprintOf(piece(bigger, "sofa-0")))).toBeNull();

    // 4 and 5. Already true of the room by then, and said to be, with the measure.
    expect(answers[COMMANDS[3]]).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/^The coffee table is already \d+ cm from the sofa/) });
    expect(answers[COMMANDS[4]]).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/^The floor lamp is already beside the sofa/) });

    // 6. The upholstery, darker.
    const darker = states[3];
    const before = findById(bigger.materials, piece(bigger, "sofa-0").materials.upholstery)!.color;
    const after = findById(darker.materials, piece(darker, "sofa-0").materials.upholstery)!.color;
    expect(parseInt(after.slice(1, 3), 16)).toBeLessThan(parseInt(before.slice(1, 3), 16));

    // 7. One command, five operations: a later hour, a warmer bulb, three warmer walls.
    const warm = changes(answers[COMMANDS[6]]);
    expect(warm.changes.flatMap((c) => c.operations.map((o) => o.kind))).toEqual(["relight", "relight", "resurface", "resurface", "resurface"]);
    expect(states[4].lights.find((l) => l.kind === "daylight")).toMatchObject({ timeOfDay: 0.36 });

    // 8. The ottoman, gone, with its relationships.
    expect(states[5].objects.some((o) => o.id === "ottoman-0")).toBe(false);
    expect(states[5].relationships.some((r) => r.subjectId === "ottoman-0" || r.objectId === "ottoman-0")).toBe(false);

    // One history step per command that changed the room.
    expect(doc.past.map((e) => e.label)).toEqual(["Move sofa toward glazed door", "Scale sofa up 15%", "Make sofa darker", "Make the room warmer", "Remove ottoman"]);
    for (let i = states.length - 2; i >= 0; i--) {
      doc = undo(doc);
      expect(doc.scene).toStrictEqual(states[i]);
    }
    expect(doc.scene).toStrictEqual(ROOM);
    for (let i = 1; i < states.length; i++) {
      doc = redo(doc);
      expect(doc.scene).toStrictEqual(states[i]);
    }
  });

  it("is deterministic: the same room and words give the same command and the same operations", async () => {
    for (const text of COMMANDS) expect(JSON.stringify(await ask(ROOM, text))).toBe(JSON.stringify(await ask(ROOM, text)));
  });
});

describe("resolving names in the real room", () => {
  it("finds pieces by name and alias, to their real ids", async () => {
    expect(changes(await ask(ROOM, "make the couch darker")).structured).toMatchObject({ target: { slots: [{ objectId: "sofa-0", slot: "upholstery" }] } });
    expect(changes(await ask(ROOM, "make the TV darker")).structured).toMatchObject({ target: { slots: [{ objectId: "television-0", slot: "screen" }] } });
    expect(changes(await ask(ROOM, "make the television darker")).structured).toMatchObject({ target: { slots: [{ objectId: "television-0" }] } });
    expect(changes(await ask(ROOM, "make the lamp warmer")).structured).toEqual({ type: "CHANGE_LIGHTING", target: { kind: "lights", ids: ["light-floor-lamp-0"] }, parameters: { change: "warmer", includeSurfaces: false } });
    // The chair's seat was not estimated from the photo; its frame was, and that is what changes.
    expect(changes(await ask(ROOM, "make the front right chair darker")).structured).toMatchObject({ target: { slots: [{ objectId: "chair-0", slot: "frame" }] } });
    expect(changes(await ask(ROOM, "make the curtains blue")).structured).toMatchObject({ target: { slots: [{ objectId: "curtain-0" }, { objectId: "curtain-1" }] } });
  });

  it("asks which chair, describing each by where it stands, rather than guessing", async () => {
    const result = await ask(ROOM, "move the chair closer to the window");
    expect(result).toMatchObject({ outcome: "clarify", message: "I found 3 chairs. Which one do you mean?" });
    const options = result.outcome === "clarify" && result.clarification.reason === "ambiguous" ? result.clarification.options : [];
    expect(options).toEqual([
      { id: "chair-0", label: "Chair", description: "front right" },
      { id: "armchair-0", label: "Armchair 1", description: "left, beside the sofa" },
      { id: "armchair-1", label: "Armchair 2", description: "back, near the coffee table" },
    ]);
    // Choosing one is selecting it: the same words then mean that chair.
    expect(changes(await ask(ROOM, "move the chair closer to the window", "armchair-1")).structured).toMatchObject({ target: { id: "armchair-1" } });
  });

  it("reads the descriptions back: sides as the photo shows them, and what a piece is near", async () => {
    const target = async (text: string) => (changes(await ask(ROOM, text)).structured as { target: { id: string } }).target.id;
    expect(await target("move the left chair forward")).toBe("armchair-0");
    expect(await target("move the front right chair left")).toBe("chair-0");
    expect(await target("move the back armchair left")).toBe("armchair-1");
    // A relationship the reconstruction recorded (armchair 1 beside the sofa)…
    expect(await target("move the chair near the sofa left")).toBe("armchair-0");
    // …and, with none recorded, plainly the nearest.
    expect(await target("move the chair near the window left")).toBe("armchair-1");
    expect(await target("move armchair 2 left")).toBe("armchair-1");
  });

  it("uses the selected piece for “this” and “it”, and asks when nothing is selected", async () => {
    expect(changes(await ask(ROOM, "rotate this 20 degrees", "chair-0")).structured).toEqual({ type: "ROTATE_OBJECT", target: { kind: "object", id: "chair-0" }, parameters: { degrees: 20, face: null } });
    expect(changes(await ask(ROOM, "make this darker", "ottoman-0")).structured).toMatchObject({ target: { slots: [{ objectId: "ottoman-0", slot: "cover" }] } });
    expect(changes(await ask(ROOM, "make it bigger", "ottoman-0")).structured).toMatchObject({ parameters: { factor: 1.15 } });
    expect(changes(await ask(ROOM, "reduce this by 20%", "coffee-table-0")).structured).toMatchObject({ target: { id: "coffee-table-0" }, parameters: { factor: 0.8 } });
    expect(changes(await ask(ROOM, "make it 10% larger", "ottoman-0")).structured).toMatchObject({ parameters: { factor: 1.1 } });
    expect(await ask(ROOM, "move this", "armchair-1")).toMatchObject({ outcome: "clarify", clarification: { reason: "no-reference" } });
    expect(await ask(ROOM, "make this darker")).toMatchObject({ outcome: "clarify", clarification: { reason: "no-selection" } });
    expect(await ask(ROOM, "rotate this 45 degrees")).toMatchObject({ outcome: "clarify", clarification: { reason: "no-selection" } });
  });

  it("stops trusting a relationship the room no longer shows", async () => {
    const against = ROOM.relationships.find((r) => r.subjectId === "sofa-0" && r.predicate === "against")!;
    expect(holds(ROOM, against)).toBe(true);
    const pulled = apply(ROOM, await ask(ROOM, "move the sofa forward 20 cm"));
    expect(holds(pulled, against)).toBe(false);
    expect(wallAgainst(ROOM, piece(ROOM, "sofa-0"))?.id).toBe("wall-left");
    // Off its wall, it no longer slides along it: a move towards the door goes straight at the door.
    expect(wallAgainst(pulled, piece(pulled, "sofa-0"))).toBeNull();
    expect(changes(await ask(ROOM, "move the sofa closer to the window")).changes[0].detail).toMatch(/along the left wall/);
    const straight = changes(await ask(pulled, "move the sofa closer to the window"));
    expect(straight.changes[0].detail).not.toMatch(/along/);
    expect(piece(apply(pulled, await ask(pulled, "move the sofa closer to the window")), "sofa-0").transform.position[0]).not.toBeCloseTo(piece(pulled, "sofa-0").transform.position[0], 2);
  });
});

describe("spatial language in the real room", () => {
  it("moves left, right, forward and back: left and right as the photo shows the room, forward the way a piece faces", async () => {
    const table = piece(ROOM, "coffee-table-0").transform.position;
    const left = piece(apply(ROOM, await ask(ROOM, "move the coffee table left")), "coffee-table-0").transform.position;
    const right = piece(apply(ROOM, await ask(ROOM, "move the coffee table right")), "coffee-table-0").transform.position;
    // The photo looks down −Z with +X to its right; the room's walls run along X and Z.
    expect(left[0]).toBeLessThan(table[0] - 0.2);
    expect(left[2]).toBeCloseTo(table[2], 6);
    expect(right[0]).toBeGreaterThan(table[0] + 0.2);
    // A table has no front of its own: forward is towards the camera.
    expect(piece(apply(ROOM, await ask(ROOM, "move the coffee table forward")), "coffee-table-0").transform.position[2]).toBeGreaterThan(table[2] + 0.2);
    // The sofa faces into the room (+X) from the left wall: forward takes it off the wall, by the distance asked.
    const sofa = piece(ROOM, "sofa-0").transform.position;
    const forward = changes(await ask(ROOM, "move the sofa forward 30 cm"));
    expect(forward.structured).toMatchObject({ parameters: { direction: "forward", distance: 0.3 } });
    expect(piece(apply(ROOM, await ask(ROOM, "move the sofa forward 30 cm")), "sofa-0").transform.position[0]).toBeCloseTo(sofa[0] + 0.3, 2);
    // Left, for the sofa, is into its wall.
    expect(await ask(ROOM, "move the sofa left")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/the wall is in the way/) });
  });

  it("moves what hangs along and up its wall, and says what a stated distance was cut to", async () => {
    const tv = piece(ROOM, "television-0").transform.position;
    expect(piece(apply(ROOM, await ask(ROOM, "move the TV down 10 cm")), "television-0").transform.position[1]).toBeCloseTo(tv[1] - 0.1, 3);
    expect(await ask(ROOM, "move the sofa up")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/only what hangs on a wall moves up or down/) });
    expect(changes(await ask(ROOM, "move the sofa closer to the window by 50 cm")).changes[0].detail).toMatch(/^moved 26 cm of the 50 cm asked along the left wall, stopping at the floor lamp$/);
  });

  it("sets pieces beside, in front of and behind others, and away from and towards things", async () => {
    expect(changes(await ask(ROOM, "move the ottoman next to armchair 2")).structured).toMatchObject({ parameters: { direction: "beside", reference: { kind: "object", id: "armchair-1" } } });
    expect(changes(await ask(ROOM, "move the coffee table in front of the sofa")).changes[0].detail).toMatch(/^set 40 cm in front of the sofa/);
    expect(await ask(ROOM, "move the ottoman behind the coffee table")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/can’t go behind the coffee table .*: the armchair 2 is in the way/) });
    expect(changes(await ask(ROOM, "move the sofa away from the wall")).structured).toMatchObject({ parameters: { direction: "away", reference: { kind: "wall", id: "wall-left" } } });
    expect(await ask(ROOM, "move the sofa farther from the TV")).toMatchObject({ outcome: "unsupported", message: "The sofa can’t move further from the television: the wall is in the way." });
  });

  it("turns a piece to face something, the short way round", async () => {
    const result = changes(await ask(ROOM, "face the TV", "chair-0"));
    expect(result.structured).toEqual({ type: "ROTATE_OBJECT", target: { kind: "object", id: "chair-0" }, parameters: { degrees: null, face: { kind: "object", id: "television-0" } } });
    const turned = piece(apply(ROOM, await ask(ROOM, "face the TV", "chair-0")), "chair-0");
    const tv = piece(ROOM, "television-0").transform.position;
    const front = [Math.sin(turned.transform.rotation[1]), Math.cos(turned.transform.rotation[1])];
    const to = [tv[0] - turned.transform.position[0], tv[2] - turned.transform.position[2]];
    // Facing it: the chair's front points at the TV to within a degree.
    expect(Math.acos((front[0] * to[0] + front[1] * to[1]) / Math.hypot(...to))).toBeLessThan(Math.PI / 180);
  });
});

describe("materials and light in the real room", () => {
  it("recolours, refinishes within what a slot allows, and refuses the rest", async () => {
    expect(changes(await ask(ROOM, "make the sofa beige")).changes[0].detail).toBe("upholstery in beige");
    expect(changes(await ask(ROOM, "change the sofa to leather")).structured).toMatchObject({ parameters: { change: { kind: "class", material: "leather" } } });
    expect(changes(await ask(ROOM, "make the walls white")).structured).toMatchObject({ target: { kind: "surfaces", surface: "walls", ids: ["wall-far", "wall-left", "wall-right"] } });
    expect(changes(await ask(ROOM, "make the floor darker")).changes[0]).toMatchObject({ target: "Floor", detail: "darkened" });
    expect(await ask(ROOM, "make the sofa glass")).toMatchObject({ outcome: "unsupported", message: "A sofa’s upholstery can be fabric or leather, not glass." });
  });

  it("warms, cools, brightens and darkens the room, and adds or takes away daylight alone", async () => {
    const hour = (scene: Scene) => (scene.lights.find((l) => l.kind === "daylight") as { timeOfDay?: number }).timeOfDay;
    expect(hour(apply(ROOM, await ask(ROOM, "make the room cooler")))).toBe(0);
    expect(changes(await ask(ROOM, "make the room brighter")).title).toBe("Make the room brighter");
    expect(changes(await ask(ROOM, "make the room darker")).title).toBe("Make the room darker");
    const more = changes(await ask(ROOM, "increase daylight"));
    expect(more.changes.flatMap((c) => c.operations)).toEqual([{ kind: "relight", lightId: "daylight", to: { timeOfDay: 0 } }]);
    expect(hour(apply(ROOM, await ask(ROOM, "reduce daylight")))).toBe(0.43);
    const midday = apply(ROOM, await ask(ROOM, "increase daylight"));
    expect(await ask(midday, "increase daylight")).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/already at its fullest/) });
  });
});

describe("what can’t be done in the real room", () => {
  it("refuses impossible requests with a reason, and changes nothing", async () => {
    expect(await ask(ROOM, "move the sofa to Mars")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/^“Mars” isn’t anything in this room/) });
    expect(await ask(ROOM, "make the TV liquid")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/^A television can’t be made liquid: its screen can be glass/) });
    expect(await ask(ROOM, "put the sofa inside the ceiling")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/^The sofa can’t go inside the ceiling/) });
    expect(await ask(ROOM, "make the ottoman 1000% bigger")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/One command can resize a piece between a third and three times its size/) });
    expect(await ask(ROOM, "make the sofa 100% smaller")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/a size has to stay above zero/) });
    expect(await ask(ROOM, "remove the plant")).toMatchObject({ outcome: "unsupported", message: "There’s no plant in this room." });
    expect(await ask(ROOM, "move the coffee table 8 metres left")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/^8\.00 m is further than this room is across \(7\.42 m\); a piece can only move within the room\.$/) });
    expect(await ask(ROOM, "move the coffee table 50 metres left")).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/distance must be more than 0 and at most 20 m/) });
    expect(await ask(ROOM, "move the window closer to the sofa")).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/part of the wall/) });
    expect(await ask(ROOM, "put the ottoman on the coffee table")).toMatchObject({ outcome: "unavailable" });
    expect(await ask(ROOM, "make the sofa sing")).toMatchObject({ outcome: "unsupported" });
  });

  it("checks every structured command against the scene before compiling it", () => {
    const move = (parameters: Partial<MoveCommand["parameters"]>): MoveCommand => ({
      type: "MOVE_OBJECT",
      target: { kind: "object", id: "sofa-0" },
      parameters: { direction: "toward", reference: { kind: "opening", id: "window-0" }, distance: null, amount: "normal", ...parameters },
    });
    expect(validateCommand(ROOM, move({}))).toEqual({ ok: true });
    expect(validateCommand(ROOM, { ...move({}), target: { kind: "object", id: "piano-0" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/no object piano-0/) });
    expect(validateCommand(ROOM, move({ reference: { kind: "opening", id: "door-9" } }))).toMatchObject({ ok: false });
    expect(validateCommand(ROOM, move({ reference: { kind: "object", id: "sofa-0" } }))).toMatchObject({ ok: false, reason: expect.stringMatching(/relative to itself/) });
    expect(validateCommand(ROOM, move({ direction: "left" }))).toMatchObject({ ok: false, reason: expect.stringMatching(/takes no reference/) });
    expect(validateCommand(ROOM, move({ distance: Number.NaN }))).toMatchObject({ ok: false });
    expect(validateCommand(ROOM, { type: "ROTATE_OBJECT", target: { kind: "object", id: "sofa-0" }, parameters: { degrees: Number.POSITIVE_INFINITY, face: null } })).toMatchObject({ ok: false });
    expect(validateCommand(ROOM, { type: "ROTATE_OBJECT", target: { kind: "object", id: "television-0" }, parameters: { degrees: 10, face: null } })).toMatchObject({ ok: false, reason: expect.stringMatching(/hangs on a wall/) });
    expect(validateCommand(ROOM, { type: "SCALE_OBJECT", target: { kind: "object", id: "sofa-0" }, parameters: { factor: -1 } })).toMatchObject({ ok: false, reason: expect.stringMatching(/above zero/) });
    expect(validateCommand(ROOM, { type: "SCALE_OBJECT", target: { kind: "object", id: "sofa-0" }, parameters: { factor: 3.5 } })).toMatchObject({ ok: false, reason: expect.stringMatching(/between a third and three times/) });
    expect(validateCommand(ROOM, { type: "CHANGE_MATERIAL", target: { kind: "slots", slots: [{ objectId: "sofa-0", slot: "wheels" }] }, parameters: { change: { kind: "tone", tone: "darker", degree: "normal" } } })).toMatchObject({ ok: false, reason: expect.stringMatching(/no wheels/) });
    expect(validateCommand(ROOM, { type: "CHANGE_MATERIAL", target: { kind: "slots", slots: [{ objectId: "television-0", slot: "screen" }] }, parameters: { change: { kind: "class", material: "fabric", word: "fabric" } } })).toMatchObject({ ok: false, reason: "A television’s screen can be glass, not fabric" });
    expect(validateCommand(ROOM, { type: "CHANGE_LIGHTING", target: { kind: "lights", ids: ["daylight"] }, parameters: { change: "warmer", includeSurfaces: false } })).toMatchObject({ ok: false });
  });
});

describe("the provider boundary", () => {
  it("holds any reader — a model's JSON included — to the same schema, and nothing it returns reaches the room unchecked", async () => {
    // A test double that answers with fixed JSON, standing in for a model's reply. Not a model.
    const fixed = (answer: unknown): IntentReader => ({ kind: "model", name: "Fixed JSON (test)", read: async () => answer });
    const viaJson = createRoomInterpreter(ROOM, fixed(JSON.parse(JSON.stringify(read("Move the sofa closer to the window")))));
    const ruled = await ask(ROOM, "Move the sofa closer to the window");
    const modelled = await viaJson.interpret({ text: "Move the sofa closer to the window", subjectId: null, scene: ROOM }, signal());
    expect(changes(modelled).structured).toEqual(changes(ruled).structured);
    expect(changes(modelled).changes).toEqual(changes(ruled).changes);

    for (const bad of [{ type: "teleport_object" }, { type: "scale_object", target: { kind: "selection" }, factor: "huge" }, { type: "move_object", target: { kind: "object", words: "sofa", categories: ["spaceship"], aliasOf: [], pointed: false, plural: false, sides: [], ordinal: null, near: null }, destination: null, degree: "normal", distance: null }]) {
      const result = await createRoomInterpreter(ROOM, fixed(bad)).interpret({ text: "anything", subjectId: null, scene: ROOM }, signal());
      expect(result).toMatchObject({ outcome: "unsupported", message: expect.stringMatching(/^That couldn’t be made into an edit/) });
    }
    expect(CATEGORIES).toContain("ottoman");
  });
});

describe("making a reconstructed piece into another kind of piece", () => {
  const REPLACEMENT_UNAVAILABLE = "I can understand the replacement request, but this furniture asset isn’t available yet.";
  const NOTHING_CHANGES = "That’s already the case, so there’s nothing to change.";

  it("reads “turn this into a round sofa” on Armchair 1 as a change, never as nothing to change", async () => {
    // A reconstructed armchair has no form of its own, and no builder draws armchair forms.
    expect(piece(ROOM, "armchair-0")).toMatchObject({ label: "Armchair 1", category: "armchair" });
    expect(piece(ROOM, "armchair-0").form).toBeUndefined();
    const result = await ask(ROOM, "Turn this into a round sofa", "armchair-0");
    expect(result).toMatchObject({
      outcome: "unavailable",
      message: REPLACEMENT_UNAVAILABLE,
      command: "Turn this into a round sofa",
      request: { kind: "replace-object", targetObjectId: "armchair-0", targetLabel: "Armchair 1", requestedForm: "round sofa", requestedAttributes: [] },
    });
    expect(result).not.toHaveProperty("already");
    expect(result).not.toMatchObject({ message: NOTHING_CHANGES });
    // Nor is a form this kind of piece has no builder for “already” true of it.
    expect(await ask(ROOM, "make this round", "armchair-0")).toMatchObject({ outcome: "unavailable", message: REPLACEMENT_UNAVAILABLE, request: { requestedForm: "round" } });
  });

  it("reaches the workspace as an understood replacement, not a “No change” note, and leaves the room as it was", async () => {
    const store = new WorkspaceStore(ROOM, "download.png", interpreter, ROOM.materials);
    store.select("armchair-0");
    expect(await store.run("Turn this into a round sofa", signal())).toBe(true);
    expect(store.getState().command).toMatchObject({ kind: null, note: null, pending: false });
    expect(store.getState().limitation).toEqual({
      command: "Turn this into a round sofa",
      message: REPLACEMENT_UNAVAILABLE,
      request: { kind: "replace-object", targetObjectId: "armchair-0", targetLabel: "Armchair 1", requestedForm: "round sofa", requestedAttributes: [] },
    });
    expect(store.getState().proposal).toBeNull();
    expect(store.getState().doc.scene).toBe(ROOM);
  });

  it("still makes the sofa round, and then says it already is", async () => {
    const round = apply(ROOM, await ask(ROOM, "Turn this into a round sofa", "sofa-0"));
    expect(piece(round, "sofa-0").form).toBe("curved");
    expect(await ask(round, "Turn this into a round sofa", "sofa-0")).toMatchObject({ outcome: "unavailable", message: NOTHING_CHANGES, already: true });
    const store = new WorkspaceStore(round, "download.png", createRoomInterpreter(round), round.materials);
    store.select("sofa-0");
    expect(await store.run("Turn this into a round sofa", signal())).toBe(false);
    expect(store.getState().command).toMatchObject({ kind: "no-change", note: NOTHING_CHANGES });
    expect(store.getState().limitation).toBeNull();
  });

  it("asks which armchair when the name fits two, and which piece when nothing is selected", async () => {
    const which = await ask(ROOM, "Turn the armchair into a round sofa");
    expect(which).toMatchObject({ outcome: "clarify", message: "I found 2 armchairs. Which one do you mean?", clarification: { reason: "ambiguous" } });
    const options = which.outcome === "clarify" && which.clarification.reason === "ambiguous" ? which.clarification.options : [];
    expect(options.map((o) => o.id)).toEqual(["armchair-0", "armchair-1"]);
    expect(await ask(ROOM, "Turn this into a round sofa")).toMatchObject({ outcome: "clarify", clarification: { reason: "no-selection" } });

    // Choosing one selects it and asks again: the same words now mean that armchair.
    const store = new WorkspaceStore(ROOM, "download.png", interpreter, ROOM.materials);
    expect(await store.run("Turn the armchair into a round sofa", signal())).toBe(false);
    expect(store.getState().command).toMatchObject({ kind: "ambiguous", options: [{ id: "armchair-0" }, { id: "armchair-1" }] });
    store.select("armchair-1");
    expect(await store.run("Turn the armchair into a round sofa", signal())).toBe(true);
    expect(store.getState().limitation).toMatchObject({ request: { targetObjectId: "armchair-1", targetLabel: "Armchair 2", requestedForm: "round sofa" } });
  });
});

describe("the workspace applying a command", () => {
  it("previews, applies as one history step, and undoes the whole command in one", async () => {
    const store = new WorkspaceStore(ROOM, "download.png", interpreter, ROOM.materials);
    await store.run("Make the room warmer", signal());
    const proposal = store.getState().proposal!;
    expect(proposal.title).toBe("Make the room warmer");
    // Previewed for the renderer; the document untouched until Apply.
    expect(store.getState().scene).not.toBe(ROOM);
    expect(store.getState().doc.scene).toBe(ROOM);
    store.acceptProposal();
    expect(store.getState().doc.past).toHaveLength(1);
    expect(store.getState().receipt).toMatchObject({ title: "Make the room warmer", changes: 3 });
    store.undo();
    expect(store.getState().doc.scene).toStrictEqual(ROOM);
    // Undone another way than its own button, the receipt goes: its Undo would take back a different step.
    expect(store.getState().receipt).toBeNull();
    store.redo();
    expect(store.getState().doc.scene).toStrictEqual(apply(ROOM, await ask(ROOM, "Make the room warmer")));
  });

  it("says what kind of answer it is, and offers the pieces an ambiguous name could mean", async () => {
    const store = new WorkspaceStore(ROOM, "download.png", interpreter, ROOM.materials);
    await store.run("remove the chair", signal());
    expect(store.getState().command).toMatchObject({ kind: "ambiguous", text: "remove the chair", options: [{ id: "chair-0" }, { id: "armchair-0" }, { id: "armchair-1" }] });
    // Choosing: select it, and ask again.
    store.select("armchair-0");
    await store.run("remove the chair", signal());
    expect(store.getState().proposal?.structured).toEqual({ type: "REMOVE_OBJECT", target: { kind: "object", id: "armchair-0" } });
    await store.run("make the TV liquid", signal());
    expect(store.getState().command).toMatchObject({ kind: "unsupported", note: expect.stringMatching(/can’t be made liquid/) });
    await store.run("what a lovely day", signal());
    expect(store.getState().command).toMatchObject({ kind: "not-understood" });
    // Selection survives a command, and is dropped only when its piece is taken away.
    store.select("ottoman-0");
    await store.run("delete the ottoman", signal());
    store.acceptProposal();
    expect(store.getState().selection).toBeNull();
    store.undo();
    expect(store.getState().doc.scene).toStrictEqual(ROOM);
  });
});
