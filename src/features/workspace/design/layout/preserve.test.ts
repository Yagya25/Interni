import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { livingRoom } from "@/demo/livingRoom";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { applyOperations } from "@/scene/model/operations";
import type { Scene } from "@/scene/model/types";
import { preRoute } from "../../agent/route";
import type { AgentInput, AgentReply, DesignAgent } from "../../agent/types";
import { validateAgentReply } from "../../agent/validate";
import { createRoomInterpreter } from "../../ai/roomInterpreter";
import { WorkspaceStore } from "../../state/store";
import { generateProposals } from "../generate";
import { validateDesignIntent, type DesignIntent } from "../intent";
import { MESSAGES } from "../messages";
import { normalise, readBrief, readDesignRequest } from "../read";
import { readLayout } from "./read";

/**
 * "Keep the existing layout" (Phase 10A).
 * ================================================================
 *
 * Asking for a style and saying the layout stays — "give the room a modern
 * theme and keep the existing layout" — is one design whose furniture does
 * not move. Before Phase 10A the words "existing", "current" and "same" hid
 * the constraint from the reader: the bare "layout" left behind was read as
 * a request for one, and the room from the photograph was rearranged around
 * its television; with no style the reader knew, "keep … layout" was read as
 * applying the direction on screen.
 */

const FIXTURE = new URL("../../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);
const parsed = parseIntermediate(JSON.parse(readFileSync(FIXTURE, "utf8")));
if (parsed.kind !== "run") throw new Error("the fixture is not a run");
const compiled = compileRoomShell(parsed.intermediate);
if (!compiled.ok) throw new Error(compiled.problem.code);
const { scene: ROOM, evidence: EVIDENCE } = compiled;
const ORIGINAL = JSON.stringify(ROOM);

const intentOf = (text: string): DesignIntent => {
  const checked = validateDesignIntent(readBrief(text));
  if (!checked.ok) throw new Error(checked.reason);
  return checked.intent;
};

/** Every way of saying it this phase reads, after a style the rules know. */
const KEEP = [
  "keep the existing layout",
  "keep the current layout",
  "keep the same layout",
  "keep the furniture where it is",
  "leave the furniture where it is",
  "keep the layout as is",
  "leave the furniture as is",
  "keep the existing layout as is",
] as const;
const modern = (keep: string) => `Give the room a modern theme and ${keep}`;
const JAPANDI = "Give the room a Japandi theme and keep the existing layout";

const KEPT = { styles: [], social: null, tvFocus: null, openness: null, circulation: null, symmetry: null, compactness: null, separation: null, preserve: true };

describe("reading “keep the existing layout”", () => {
  it("reads it as keeping the furniture where it is, and the rest as the style asked for", () => {
    for (const keep of KEEP) {
      const text = modern(keep);
      // Every word of the constraint is taken; only the finishes are left to read.
      expect(readLayout(normalise(text)), text).toMatchObject({ layout: KEPT, rest: "give the room a modern theme and" });
      expect(readDesignRequest(text), text).toEqual({ kind: "brief" });
      expect(preRoute(text), text).toEqual({ to: "agent", rulesBrief: true, question: false });
      expect(intentOf(text), text).toMatchObject({ styles: ["MODERN_WARM"], finishes: true, variantCount: 1, layout: KEPT });
    }
  });

  it("is never an apply of what is on screen, said on its own or with a style the rules do not know", () => {
    for (const text of ["Keep the existing layout", "Keep the current layout", "Keep the same layout", JAPANDI]) {
      expect(readLayout(normalise(text))?.layout.preserve, text).toBe(true);
      // Nothing for the rules to build, so not a brief; and not an act on a direction either.
      expect(readDesignRequest(text), text).toBeNull();
      expect(readBrief(text), text).toBeNull();
    }
    // The rules know no Japandi style: in agent mode the words go to the command rules, then to the agent.
    expect(preRoute(JAPANDI)).toEqual({ to: "command" });
    // "Keep" pointing at a direction on screen is still an apply.
    expect(readDesignRequest("keep this layout")).toEqual({ kind: "session", action: "apply", ordinal: null });
    expect(readDesignRequest("keep the second layout")).toEqual({ kind: "session", action: "apply", ordinal: 2 });
  });
});

describe("a style with the layout kept", () => {
  const rooms: readonly [string, Scene][] = [
    ["the room from the photograph", ROOM],
    ["the demonstration room", livingRoom],
  ];

  it.each(rooms)("is one ordinary design that moves nothing, in %s", (_, scene) => {
    const [alone] = generateProposals(scene, intentOf("Give the room a modern theme")).proposals;
    for (const keep of KEEP) {
      const text = modern(keep);
      const result = generateProposals(scene, intentOf(text));
      expect(result.ok, text).toBe(true);
      expect(result.proposals, text).toHaveLength(1);
      const [proposal] = result.proposals;
      expect(proposal).toMatchObject({ title: "Modern Warm", style: "MODERN_WARM", layout: null });
      expect(proposal.operations.some((op) => op.kind === "move"), text).toBe(false);
      // The theme's own finishes, operation for operation, and the promise said.
      expect(JSON.stringify(proposal.operations), text).toBe(JSON.stringify(alone.operations));
      expect(proposal.constraints, text).toContain(MESSAGES.preserved);
      // Every piece stands exactly where it stood.
      const after = applyOperations(scene, proposal.operations);
      expect(after.objects.map((o) => o.transform), text).toEqual(scene.objects.map((o) => o.transform));
    }
  });
});

// ---------------------------------------------------------------------------
// In the workspace, with a layout already on screen and previewed.

const store = () => new WorkspaceStore(ROOM, "download.png", createRoomInterpreter(ROOM), ROOM.materials);
const run = (s: WorkspaceStore, text: string) => s.run(text, new AbortController().signal);

/** A scripted agent: a test double whose replies are checked by the real validator. Not a model. */
function withAgent(...designs: string[]) {
  const read = vi.fn(async (input: AgentInput): Promise<{ ok: true; reply: AgentReply }> => {
    const next = designs.shift();
    if (next === undefined) throw new Error("the agent was asked more than expected");
    const wire = { version: "agent-reply-0.1", route: "design", design: { ...(readBrief(next) as object) }, question: null, clarify: null, outOfScope: null };
    const checked = validateAgentReply(wire, input.text);
    if (!checked.ok) throw new Error(`scripted reply is invalid: ${checked.reason}`);
    return { ok: true, reply: checked.reply };
  });
  const agent: DesignAgent = { kind: "model", name: "Scripted", read };
  const s = store();
  s.setAgent({ agent, evidence: EVIDENCE });
  return { s, read };
}

/** Three layouts on screen, the first previewed. */
async function layoutPreviewed(s: WorkspaceStore) {
  await run(s, "Give me three furniture layouts");
  const [first] = s.getState().design!.proposals;
  expect(first.operations.some((op) => op.kind === "move")).toBe(true);
  s.previewDesign(first.id);
}

describe("in the workspace, with a layout previewed", () => {
  it("makes the modern theme a new design that moves nothing, and applies nothing", async () => {
    const s = store();
    await layoutPreviewed(s);
    const text = modern("keep the existing layout");
    expect(await run(s, text)).toBe(true);
    const design = s.getState().design!;
    expect(design.request).toBe(text);
    expect(design.proposals.map((p) => p.title)).toEqual(["Modern Warm"]);
    expect(design.proposals[0].operations.some((op) => op.kind === "move")).toBe(false);
    expect(s.getState().doc.past).toHaveLength(0);
    expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
  });

  it("never applies the previewed layout for the Japandi request, with the agent off", async () => {
    const s = store();
    await layoutPreviewed(s);
    await run(s, JAPANDI);
    expect(s.getState().doc.past).toHaveLength(0);
    expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
  });

  it("asks the agent for the Japandi request, and builds what it reads with the layout kept", async () => {
    // The agent may only answer with a style the engine has; here, the minimal one.
    const { s, read } = withAgent("Give me three furniture layouts", "Give the room a minimal theme and keep the existing layout");
    await layoutPreviewed(s);
    expect(await run(s, JAPANDI)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    const design = s.getState().design!;
    expect(design.request).toBe(JAPANDI);
    expect(design.proposals).toHaveLength(1);
    expect(design.proposals[0]).toMatchObject({ style: "MINIMAL_NEUTRAL", layout: null });
    expect(design.proposals[0].operations.some((op) => op.kind === "move")).toBe(false);
    expect(s.getState().doc.past).toHaveLength(0);
    expect(JSON.stringify(s.getState().doc.scene)).toBe(ORIGINAL);
  });
});
