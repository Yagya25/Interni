import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { applyOperations } from "@/scene/model/operations";
import { createRoomInterpreter } from "../ai/roomInterpreter";
import { validateDesignIntent } from "../design/intent";
import { readBrief } from "../design/read";
import { fromIntent } from "../design/session";
import { WorkspaceStore } from "../state/store";
import { checkDirections, directionsNote, evaluateDirections } from "./evaluate";
import { AGENT_MESSAGES } from "./messages";
import { readThresholdQuestion } from "./question";
import { preRoute } from "./route";
import type { AgentFailure, AgentInput, AgentReply, DesignAgent, DirectionQuestion } from "./types";
import { validateAgentReply } from "./validate";

/**
 * Phase 9 through the workspace store: checks on a design's new directions,
 * and questions about the directions on screen. A scripted agent stands in
 * for the model; its replies pass the real validator. Phase 6's own store
 * tests (agent.store.test.ts) run unchanged beside these.
 */

const FIXTURE = new URL("../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);
const parsed = parseIntermediate(JSON.parse(readFileSync(FIXTURE, "utf8")));
if (parsed.kind !== "run") throw new Error("fixture");
const compiled = compileRoomShell(parsed.intermediate);
if (!compiled.ok) throw new Error("compile");
const { scene: ROOM, evidence: EVIDENCE } = compiled;
const ORIGINAL = JSON.stringify(ROOM);

const run = (s: WorkspaceStore, text: string) => s.run(text, new AbortController().signal);
const q = (kind: DirectionQuestion["kind"], over: Partial<DirectionQuestion> = {}): DirectionQuestion => ({ kind, subject: null, other: null, metres: null, ...over }) as DirectionQuestion;

const LAYOUTS = readBrief("Give me three furniture layouts") as Record<string, unknown>;
const ONE_LAYOUT = readBrief("Give me a conversation layout") as Record<string, unknown>;
const v02 = (over: Record<string, unknown>) => ({ version: "agent-reply-0.2", route: "design", design: null, checks: null, question: null, directions: null, clarify: null, outOfScope: null, ...over });
const designs = (design = LAYOUTS, checks: DirectionQuestion[] | null = null) => v02({ design, checks });
const asks = (question: DirectionQuestion, directions: number[]) => v02({ route: "question", question, directions });

/** A scripted agent: a test double that returns replies checked by the real validator. Not a model. */
function withAgent(...answers: (Record<string, unknown> | AgentFailure)[]) {
  const read = vi.fn(async (input: AgentInput): Promise<{ ok: true; reply: AgentReply } | { ok: false; failure: AgentFailure }> => {
    const next = answers.shift();
    if (next === undefined) throw new Error("the agent was asked more than expected");
    if (typeof next === "string") return { ok: false, failure: next };
    const checked = validateAgentReply(next, input.text);
    if (!checked.ok) throw new Error(`scripted reply is invalid: ${checked.reason}`);
    return { ok: true, reply: checked.reply };
  });
  const agent: DesignAgent = { kind: "model", name: "Scripted", read };
  const s = new WorkspaceStore(ROOM, "download.png", createRoomInterpreter(ROOM), ROOM.materials);
  s.setAgent({ agent, evidence: EVIDENCE });
  return { s, read };
}

function expectedDesigns(text: string, design: Record<string, unknown>) {
  const intent = validateDesignIntent(design);
  if (!intent.ok) throw new Error(intent.reason);
  const out = fromIntent(text, intent.intent, ROOM);
  if (out.outcome !== "designs") throw new Error("expected designs");
  return out.session;
}

describe("a design with checks", () => {
  const text = "Give me three layouts that keep at least 80 cm of circulation, and tell me which leaves the most circulation area";
  const checks = [q("circulation-at-least", { metres: 0.8 }), q("circulation-area")];

  it("offers exactly the proposals the engine makes, with what was measured beside them", async () => {
    const { s, read } = withAgent(designs(LAYOUTS, checks));
    expect(await run(s, text)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const { design, doc, command } = s.getState();
    const expected = expectedDesigns(text, LAYOUTS);
    // Byte-identical proposals: a checked direction is the same plan as an unchecked one.
    expect(JSON.stringify(design!.proposals)).toBe(JSON.stringify(expected.proposals));
    expect(design!.proposals.every((p) => !("checks" in p))).toBe(true);
    expect(design!.checks!.map((c) => c.label)).toEqual(["At least 80 cm to every seat", "Circulation area"]);
    expect(design!.checks!.every((c) => c.measuredOn === doc.scene)).toBe(true);
    const again = checkDirections(expected.proposals, checks, { room: ROOM, shown: ROOM, evidence: EVIDENCE, selectionId: null });
    expect(command).toMatchObject({ kind: "answer", note: again.note });
    expect(command.note).toMatch(/^Measured on each new direction: At least 80 cm to every seat: no for 1 and 2; too close to call for 3\. Open floor leaves the most circulation area/);
    // Nothing applied, nothing previewed.
    expect(doc.past).toHaveLength(0);
    expect(design!.previewId).toBeNull();
    expect(JSON.stringify(doc.scene)).toBe(ORIGINAL);
  });

  it("previews, applies as one step, and undoes a checked direction exactly as an unchecked one", async () => {
    const checked = withAgent(designs(LAYOUTS, checks)).s;
    const plain = withAgent(designs(LAYOUTS)).s;
    await run(checked, text);
    await run(plain, text);
    expect(plain.getState().design).not.toHaveProperty("checks");
    const [a, b] = [checked, plain].map((s) => s.getState().design!.proposals[2].id);

    checked.previewDesign(a);
    plain.previewDesign(b);
    expect(JSON.stringify(checked.getState().scene)).toBe(JSON.stringify(plain.getState().scene));
    expect(JSON.stringify(checked.getState().scene)).toBe(JSON.stringify(applyOperations(ROOM, checked.getState().design!.proposals[2].operations)));
    checked.exitDesignPreview();
    expect(checked.getState().scene).toBe(checked.getState().doc.scene);

    checked.applyDesign(a);
    plain.applyDesign(b);
    expect(checked.getState().doc.past.map((e) => e.label)).toEqual(["Open floor"]);
    expect(JSON.stringify(checked.getState().doc.scene)).toBe(JSON.stringify(plain.getState().doc.scene));
    // The room has changed since the directions were measured: their lines no longer describe it.
    expect(checked.getState().design!.checks!.every((c) => c.measuredOn !== checked.getState().doc.scene)).toBe(true);

    checked.undo();
    expect(JSON.stringify(checked.getState().doc.scene)).toBe(ORIGINAL);
    checked.redo();
    expect(JSON.stringify(checked.getState().doc.scene)).toBe(JSON.stringify(plain.getState().doc.scene));
  });

  it("names the pieces when a check's name fits several, and still offers the designs", async () => {
    const { s } = withAgent(designs(LAYOUTS, [q("walkway", { subject: "the chair" })]));
    expect(await run(s, "Give me three layouts and check the way to the chair")).toBe(true);
    expect(s.getState().design!.proposals).toHaveLength(3);
    expect(s.getState().design!.checks).toEqual([]);
    expect(s.getState().command.note).toBe("Measured on each new direction: Not checked — more than one piece fits (Chair, Armchair 1, Armchair 2): name one to check it.");
  });
});

describe("a question about the directions on screen", () => {
  async function withLayouts(...then: (Record<string, unknown> | AgentFailure)[]) {
    const agent = withAgent(designs(), ...then);
    await run(agent.s, "Give me three furniture layouts");
    return agent;
  }

  it("measures each direction and changes nothing: not the document, the history, the preview or the session", async () => {
    const question = q("circulation-area");
    const { s } = await withLayouts(asks(question, [1, 2, 3]));
    s.previewDesign(s.getState().design!.proposals[1].id);
    const before = s.getState();
    const text = "Which layout leaves the most circulation area?";
    expect(await run(s, text)).toBe(false);
    const after = s.getState();
    expect(after.design).toBe(before.design);
    expect(after.doc).toBe(before.doc);
    // The store lays a previewed direction over the document again on every change of state (as it
    // does for any note): the preview drawn is the same arrangement, still the second direction.
    expect(JSON.stringify(after.scene)).toBe(JSON.stringify(before.scene));
    expect(after.design!.previewId).toBe(before.design!.proposals[1].id);
    const e = evaluateDirections({ question, room: ROOM, shown: before.scene, evidence: EVIDENCE, selectionId: null, directions: before.design!.proposals.map((proposal, i) => ({ ordinal: i + 1, proposal })) });
    if (!e.ok) throw new Error("expected an evaluation");
    expect(after.command).toMatchObject({ kind: "answer", text, note: directionsNote(e, ROOM) });
    expect(after.command.note).toContain("Open floor leaves the most circulation area; the others cannot be meaningfully told apart.");
    expect(JSON.stringify(after.doc.scene)).toBe(ORIGINAL);
  });

  it("answers one direction with Phase 5's own sentence, measured on it", async () => {
    const { s } = await withLayouts(asks(q("circulation-at-least", { metres: 0.8 }), [3]));
    await run(s, "Does the third layout keep at least 80 cm of circulation to every seat?");
    expect(s.getState().command.note).toMatch(/^3\. Open floor, laid over the room as its preview shows it: Too close to call against 80 cm/);
  });

  it("says so when no directions are on screen, or fewer than it names", async () => {
    const none = withAgent(asks(q("free-floor"), [1, 2]));
    await run(none.s, "Which design leaves the most free floor?");
    expect(none.s.getState().command).toMatchObject({ kind: "unsupported", note: AGENT_MESSAGES.directions.none });

    const one = withAgent(designs(ONE_LAYOUT), asks(q("free-floor"), [1, 3]));
    await run(one.s, "Give me a conversation layout");
    expect(one.s.getState().design!.proposals).toHaveLength(1);
    await run(one.s, "How much free floor do the first and third leave?");
    expect(one.s.getState().command).toMatchObject({ kind: "unsupported", note: "There is one direction on screen." });
  });

  it("asks which piece when a name fits several, then measures without asking the model again", async () => {
    const { s, read } = await withLayouts(asks(q("walkway", { subject: "the chair" }), [1, 2, 3]));
    const text = "Which layout leaves the widest way to the chair?";
    await run(s, text);
    expect(s.getState().command).toMatchObject({ kind: "ambiguous", tone: "select" });
    expect(s.getState().command.options.map((o) => o.label)).toEqual(["Chair", "Armchair 1", "Armchair 2"]);
    // As the command bar does it: select the piece, ask the same words again.
    s.select("armchair-1");
    await run(s, text);
    expect(read).toHaveBeenCalledTimes(2);
    expect(s.getState().command.kind).toBe("answer");
    expect(s.getState().command.note).toMatch(/^Way to Armchair 2, with each direction laid over the room/);
  });

  it("never answers words about the directions on screen with the room, when the agent fails", async () => {
    const text = "Check the second one keeps at least 80 cm to walk through";
    expect(preRoute(text)).toMatchObject({ onScreen: true });
    // The rules alone could read a threshold here — about the room as shown, not the second direction.
    expect(readThresholdQuestion(text)).toMatchObject({ kind: "circulation-at-least", metres: 0.8 });
    const { s } = await withLayouts("unavailable");
    const before = s.getState().design;
    await run(s, text);
    expect(s.getState().command.note).toBe(`${AGENT_MESSAGES.failure.unavailable} ${AGENT_MESSAGES.notAnswered}`);
    // Not answered about the room as shown, not previewed, not replaced.
    expect(s.getState().design).toBe(before);
    expect(s.getState().design!.previewId).toBeNull();
  });
});
