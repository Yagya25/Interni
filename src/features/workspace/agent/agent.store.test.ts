import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { createRoomInterpreter } from "../ai/roomInterpreter";
import { validateDesignIntent } from "../design/intent";
import { readBrief } from "../design/read";
import { fromIntent } from "../design/session";
import { answer } from "../measure";
import { WorkspaceStore } from "../state/store";
import { httpAgent } from "./client";
import { AGENT_MESSAGES } from "./messages";
import type { AgentFailure, AgentInput, AgentReply, DesignAgent } from "./types";
import { validateAgentReply } from "./validate";

const FIXTURE = new URL("../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);
const parsed = parseIntermediate(JSON.parse(readFileSync(FIXTURE, "utf8")));
if (parsed.kind !== "run") throw new Error("fixture");
const compiled = compileRoomShell(parsed.intermediate);
if (!compiled.ok) throw new Error("compile");
const { scene: ROOM, evidence: EVIDENCE } = compiled;
const ORIGINAL = JSON.stringify(ROOM);

const store = () => new WorkspaceStore(ROOM, "download.png", createRoomInterpreter(ROOM), ROOM.materials);
const run = (s: WorkspaceStore, text: string) => s.run(text, new AbortController().signal);

const wire = (over: Record<string, unknown>) => ({ version: "agent-reply-0.1", route: "design", design: null, question: null, clarify: null, outOfScope: null, ...over });
const designWire = (text: string) => wire({ design: { ...(readBrief(text) as object) } });
const questionWire = (q: Record<string, unknown>) => wire({ route: "question", question: { kind: "room-size", subject: null, other: null, metres: null, ...q } });

/** A scripted agent: a test double that returns replies checked by the real validator. Not a model. */
function scripted(...answers: (Record<string, unknown> | AgentFailure)[]) {
  const read = vi.fn(async (input: AgentInput): Promise<{ ok: true; reply: AgentReply } | { ok: false; failure: AgentFailure }> => {
    const next = answers.shift();
    if (next === undefined) throw new Error("the agent was asked more than expected");
    if (typeof next === "string") return { ok: false, failure: next };
    const checked = validateAgentReply(next, input.text);
    if (!checked.ok) throw new Error(`scripted reply is invalid: ${checked.reason}`);
    return { ok: true, reply: checked.reply };
  });
  const agent: DesignAgent = { kind: "model", name: "Scripted", read };
  return { agent, read };
}

function withAgent(...answers: (Record<string, unknown> | AgentFailure)[]) {
  const s = store();
  const { agent, read } = scripted(...answers);
  s.setAgent({ agent, evidence: EVIDENCE });
  return { s, read };
}

describe("agent off: nothing changes", () => {
  it("routes the two misread sentences exactly as the frozen rules do", async () => {
    const s = store();
    await run(s, "Is there at least 80 cm of circulation space?");
    // The rules-only reading, unchanged in Phase 6: taken for a design brief (and refused, "80" read as a count).
    expect(s.getState().design).toBeNull();
    expect(s.getState().command.note).toBe("That couldn’t be made into designs: variantCount must be at most 3.");
    expect(s.getState().doc.past).toHaveLength(0);
  });

  it("keeps commands and designs on the rules", async () => {
    const s = store();
    expect(await run(s, "Move the sofa forward 20 cm")).toBe(true);
    expect(s.getState().proposal?.title).toMatch(/Move sofa/);
    await run(s, "Give me 3 modern designs");
    expect(s.getState().design?.proposals.map((p) => p.title)).toEqual(["Modern Warm", "Modern Neutral", "Modern Dark Accent"]);
  });
});

describe("agent on: designs", () => {
  it("builds the agent's design through the existing engine, exactly as fromIntent does", async () => {
    const text = "Make it feel like a Kyoto tea house but keep it bright";
    const reply = wire({ design: { ...(readBrief("Give me a calm minimal design, bright") as object) } });
    const { s, read } = withAgent(reply);
    expect(await run(s, text)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const intent = validateDesignIntent((reply as { design: unknown }).design);
    if (!intent.ok) throw new Error(intent.reason);
    const expected = fromIntent(text, intent.intent, ROOM);
    if (expected.outcome !== "designs") throw new Error("expected designs");
    expect(JSON.stringify(s.getState().design?.proposals)).toBe(JSON.stringify(expected.session.proposals));
    expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
    expect(s.getState().doc.past).toHaveLength(0);
  });

  it("never applies a previewed design when the words only say “keep it bright”", async () => {
    const { s } = withAgent(designWire("Give me 3 modern designs"), designWire("Give me a calm minimal design, bright"));
    await run(s, "Give me 3 modern designs");
    const first = s.getState().design!.proposals[0];
    s.previewDesign(first.id);
    await run(s, "Make it feel like a Kyoto tea house but keep it bright");
    expect(s.getState().doc.past).toHaveLength(0);
    expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
    expect(s.getState().design?.request).toBe("Make it feel like a Kyoto tea house but keep it bright");
  });

  it("previews, applies as one step, and undoes and redoes a layout the agent asked for, exactly", async () => {
    const { s } = withAgent(designWire("Give me three furniture layouts."));
    await run(s, "Rearrange my furniture so it's nicer for talking");
    const [layout] = s.getState().design!.proposals;
    expect(layout.operations.every((op) => op.kind === "move")).toBe(true);
    s.previewDesign(layout.id);
    expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
    s.exitDesignPreview();
    expect(s.getState().scene).toBe(s.getState().doc.scene);
    s.applyDesign(layout.id);
    expect(s.getState().doc.past).toHaveLength(1);
    const applied = JSON.stringify(s.getState().doc.scene);
    s.undo();
    expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
    s.redo();
    expect(JSON.stringify(s.getState().doc.scene)).toBe(applied);
  });

  it("leaves acts on the directions on screen, and Phase 3E commands, to the rules — the agent is not asked", async () => {
    const { s, read } = withAgent(designWire("Give me 3 modern designs"));
    await run(s, "Give me 3 modern designs");
    expect(read).toHaveBeenCalledTimes(1);
    await run(s, "Apply the second design");
    expect(s.getState().doc.past).toHaveLength(1);
    await run(s, "Move the sofa forward 20 cm");
    expect(s.getState().proposal?.title).toMatch(/Move sofa/);
    await run(s, "Move the chair");
    expect(s.getState().command.kind).toBe("ambiguous");
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("agent on: questions", () => {
  it("answers with Phase 5's own words and numbers, and changes nothing", async () => {
    const { s } = withAgent(questionWire({ kind: "distance", subject: "the sofa", other: "the coffee table" }));
    expect(await run(s, "How much space is between the sofa and the coffee table?")).toBe(false);
    const expected = answer(ROOM, EVIDENCE, { kind: "distance", from: "sofa-0", to: "coffee-table-0" });
    if (!expected.ok) throw new Error(expected.reason);
    expect(s.getState().command).toMatchObject({ kind: "answer", note: expected.text });
    expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
    expect(s.getState().design).toBeNull();
  });

  it("answers “at least 80 cm” as a question, not a layout", async () => {
    const { s } = withAgent(questionWire({ kind: "circulation-at-least", metres: 0.8 }));
    await run(s, "Is there at least 80 cm of circulation space?");
    expect(s.getState().design).toBeNull();
    expect(s.getState().command.kind).toBe("answer");
    expect(s.getState().command.note).toMatch(/^No: the way from Glazed door .* below 80 cm/);
  });

  it("answers “the way in to the sofa” as a walkway, with Phase 5's walkway answer", async () => {
    const { s } = withAgent(questionWire({ kind: "walkway", subject: "the sofa" }));
    await run(s, "How wide is the way in to the sofa?");
    const expected = answer(ROOM, EVIDENCE, { kind: "walkway", objectId: "sofa-0" });
    if (!expected.ok) throw new Error(expected.reason);
    expect(s.getState().command).toMatchObject({ kind: "answer", note: expected.text });
    expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
  });

  it("asks which piece when a name fits several, then answers without asking the model again", async () => {
    const { s, read } = withAgent(questionWire({ kind: "clearance", subject: "the chair" }));
    const text = "How much clearance is there around the chair?";
    await run(s, text);
    expect(s.getState().command.kind).toBe("ambiguous");
    expect(s.getState().command.options.map((o) => o.label)).toEqual(["Chair", "Armchair 1", "Armchair 2"]);
    s.select("armchair-1");
    await run(s, text);
    expect(read).toHaveBeenCalledTimes(1);
    expect(s.getState().command.kind).toBe("answer");
    expect(s.getState().command.note).toMatch(/^Around Armchair 2:/);
  });

  it("says a piece is missing in the person's words, rather than guessing", async () => {
    const { s } = withAgent(questionWire({ kind: "object-size", subject: "the piano" }));
    await run(s, "How big is the piano?");
    expect(s.getState().command.kind).toBe("unsupported");
    expect(s.getState().command.note).toMatch(/piano/);
  });
});

describe("agent on: other routes", () => {
  it("hands a polite command back to the Phase 3E rules in the person's own words", async () => {
    const { s } = withAgent(wire({ route: "command" }));
    expect(await run(s, "Can you move the sofa forward 20 cm?")).toBe(true);
    expect(s.getState().proposal?.title).toMatch(/Move sofa/);
  });

  it("says so when the model calls something a command the rules could not read", async () => {
    const { s, read } = withAgent(wire({ route: "command" }));
    await run(s, "Do something nice with it");
    expect(read).toHaveBeenCalledTimes(1);
    expect(s.getState().command).toMatchObject({ kind: "not-understood", note: AGENT_MESSAGES.commandNotRead });
    // And words the rules could not read first, then called a command by the model.
    const b = withAgent(wire({ route: "command" }));
    await run(b.s, "Surprise me with the couch");
    expect(b.read).toHaveBeenCalledTimes(1);
    expect(b.s.getState().command).toMatchObject({ kind: "not-understood", note: AGENT_MESSAGES.commandNotRead });
  });

  it("answers clarify and out-of-scope with fixed sentences", async () => {
    const a = withAgent(wire({ route: "clarify", clarify: "too-vague" }));
    await run(a.s, "Make it nicer?");
    expect(a.s.getState().command.note).toBe(AGENT_MESSAGES.clarify["too-vague"]);
    const b = withAgent(wire({ route: "out_of_scope", outOfScope: "new-furniture" }));
    await run(b.s, "Where can I buy a rug like this?");
    expect(b.s.getState().command.note).toBe(AGENT_MESSAGES.outOfScope["new-furniture"]);
    expect(JSON.stringify(b.s.getState().doc.scene)).toBe(ORIGINAL);
  });
});

describe("agent on: failures never touch the room", () => {
  it("falls back to the design rules for a brief they can read, and says so", async () => {
    for (const failure of ["unavailable", "timeout", "refused", "invalid", "rate-limited"] as const) {
      const { s } = withAgent(failure);
      expect(await run(s, "Give me 3 modern designs")).toBe(true);
      expect(s.getState().design?.proposals.map((p) => p.title)).toEqual(["Modern Warm", "Modern Neutral", "Modern Dark Accent"]);
      expect(s.getState().command).toMatchObject({ kind: "agent", note: `${AGENT_MESSAGES.failure[failure]} ${AGENT_MESSAGES.readByRules}` });
      expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
    }
  });

  it("says a question couldn't be answered, and invents nothing", async () => {
    const { s } = withAgent("timeout");
    await run(s, "How wide is the room?");
    expect(s.getState().command).toMatchObject({ kind: "agent", note: `${AGENT_MESSAGES.failure.timeout} ${AGENT_MESSAGES.notAnswered}` });
    expect(s.getState().design).toBeNull();
  });

  it("answers a stated circulation threshold as a measurement when the agent fails — never as a design count", async () => {
    const text = "Is there at least 80 cm of circulation space?";
    const expected = answer(ROOM, EVIDENCE, { kind: "circulation-at-least", metres: 0.8 });
    if (!expected.ok) throw new Error(expected.reason);
    for (const failure of ["invalid", "unavailable", "timeout", "refused", "rate-limited"] as const) {
      const { s, read } = withAgent(failure);
      expect(await run(s, text)).toBe(false);
      expect(read).toHaveBeenCalledTimes(1);
      expect(s.getState().command).toMatchObject({ kind: "answer", note: `${AGENT_MESSAGES.failure[failure]} ${AGENT_MESSAGES.readByMeasureRules} ${expected.text}` });
      expect(s.getState().command.note).not.toMatch(/variantCount|designs/);
      expect(s.getState().design).toBeNull();
      expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
      expect(s.getState().doc.past).toHaveLength(0);
    }
  });

  it("clears quietly when cancelled", async () => {
    const { s } = withAgent("cancelled");
    await run(s, "How wide is the room?");
    expect(s.getState().command).toMatchObject({ pending: false, note: null });
  });

  it("rejects a hostile reply in the browser too, through the real HTTP client", async () => {
    const hostile = [
      { ...designWire("Give me 3 modern designs"), operations: [{ kind: "remove", objectId: "sofa-0" }] },
      questionWire({ kind: "object-size", subject: "sofa-0", objectId: "sofa-0" }),
      wire({ design: { ...(readBrief("Give me 3 modern designs") as object), position: [1, 0, 2] } }),
      questionWire({ kind: "circulation-at-least", metres: 0.2 }),
    ];
    for (const reply of hostile) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, reply }), { status: 200 }));
      const s = store();
      s.setAgent({ agent: httpAgent("claude-opus-5", fetchImpl as unknown as typeof fetch), evidence: EVIDENCE });
      await run(s, "How big is it, 80 cm?");
      expect(s.getState().command.kind).toBe("agent");
      expect(s.getState().command.note).toContain(AGENT_MESSAGES.failure.invalid);
      expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
      expect(s.getState().design).toBeNull();
      expect(s.getState().proposal).toBeNull();
    }
  });

  it("sends the brief, not the Scene: labels and rounded numbers only", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, failure: "unavailable" }), { status: 200 }));
    const s = store();
    s.setAgent({ agent: httpAgent("claude-opus-5", fetchImpl as unknown as typeof fetch), evidence: EVIDENCE });
    await run(s, "How wide is the room?");
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(Object.keys(body).sort()).toEqual(["brief", "text"]);
    expect(body.brief).not.toMatch(/sofa-0|coffee-table-0|window-0/);
    expect(body.brief.length).toBeLessThan(8000);
  });
});
