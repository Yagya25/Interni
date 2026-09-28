import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { LAYOUT_AXES, LAYOUT_STYLES } from "../design/layout/intent";
import { readDesignRequest } from "../design/read";
import { STYLE_ORDER } from "../design/styles";
import { roomBrief } from "./brief";
import { readThresholdQuestion } from "./question";
import { SYSTEM_PROMPT } from "./prompt";
import { preRoute } from "./route";
import { AGENT_REPLY_SCHEMA, FINISH_AXES } from "./schema";
import { QUESTION_KINDS } from "./types";
import { statedLengths, validateAgentReply } from "./validate";

const FIXTURE = new URL("../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);
const parsed = parseIntermediate(JSON.parse(readFileSync(FIXTURE, "utf8")));
if (parsed.kind !== "run") throw new Error("fixture");
const compiled = compileRoomShell(parsed.intermediate);
if (!compiled.ok) throw new Error("compile");
const { scene: ROOM, evidence: EVIDENCE } = compiled;

export const design = (over: Record<string, unknown> = {}) => ({
  version: "design-intent-0.2",
  styles: ["SCANDINAVIAN"],
  atmosphere: "calm and bright",
  warmth: null,
  brightness: 0.65,
  contrast: null,
  luxury: null,
  minimalism: 0.65,
  coziness: null,
  variantCount: 1,
  finishes: true,
  layout: null,
  ...over,
});
const layout = (over: Record<string, unknown> = {}) => ({
  styles: ["CONVERSATION"],
  social: 1,
  tvFocus: null,
  openness: null,
  circulation: null,
  symmetry: null,
  compactness: null,
  separation: null,
  preserve: false,
  ...over,
});
const reply = (over: Record<string, unknown> = {}) => ({ version: "agent-reply-0.1", route: "design", design: design(), question: null, clarify: null, outOfScope: null, ...over });
const question = (q: Record<string, unknown>) => reply({ route: "question", design: null, question: { kind: "room-size", subject: null, other: null, metres: null, ...q } });

describe("the reply schema", () => {
  it("is built from the code's own vocabulary", () => {
    const props = AGENT_REPLY_SCHEMA.properties as Record<string, { anyOf?: { properties?: Record<string, { enum?: unknown; items?: { enum?: unknown }; anyOf?: unknown }> }[] }>;
    const d = props.design.anyOf![0].properties!;
    expect(d.styles.items!.enum).toEqual([...STYLE_ORDER]);
    for (const axis of FINISH_AXES) expect(d[axis]).toBeDefined();
    const l = (d.layout.anyOf as { properties: Record<string, { items?: { enum?: unknown } }> }[])[0].properties;
    expect(l.styles.items!.enum).toEqual([...LAYOUT_STYLES]);
    for (const axis of LAYOUT_AXES) expect(l[axis]).toBeDefined();
    expect(props.question.anyOf![0].properties!.kind.enum).toEqual([...QUESTION_KINDS]);
  });

  it("has no field that could carry an id, an operation, a position, an angle, a colour or a material", () => {
    const keys = JSON.stringify(AGENT_REPLY_SCHEMA).match(/"([a-zA-Z]+)":/g)!.map((k) => k.slice(1, -2).toLowerCase());
    for (const forbidden of ["id", "objectid", "ids", "operations", "operation", "position", "rotation", "angle", "degrees", "color", "colour", "material", "materialid", "transform", "scene"]) {
      expect(keys).not.toContain(forbidden);
    }
    // Every object in it is closed.
    expect(JSON.stringify(AGENT_REPLY_SCHEMA)).not.toMatch(/"additionalProperties":true/);
  });
});

describe("validateAgentReply", () => {
  it("accepts a well-formed reply for each route", () => {
    expect(validateAgentReply(reply(), "Make it calm and bright")).toMatchObject({ ok: true, reply: { route: "design" } });
    expect(validateAgentReply(reply({ design: design({ finishes: false, styles: [], atmosphere: null, brightness: null, minimalism: null, layout: layout() }) }), "a conversation layout")).toMatchObject({ ok: true });
    expect(validateAgentReply(question({ kind: "distance", subject: "the sofa", other: "the coffee table" }), "how far apart")).toMatchObject({ ok: true });
    expect(validateAgentReply(reply({ route: "command", design: null }), "x")).toMatchObject({ ok: true, reply: { route: "command" } });
    expect(validateAgentReply(reply({ route: "clarify", design: null, clarify: "too-vague" }), "x")).toMatchObject({ ok: true });
    expect(validateAgentReply(reply({ route: "out_of_scope", design: null, outOfScope: "shopping" }), "x")).toMatchObject({ ok: true });
  });

  it("rejects unknown fields rather than stripping them, at every level", () => {
    expect(validateAgentReply({ ...reply(), operations: [] }, "x")).toMatchObject({ ok: false, reason: "reply has unknown field: operations" });
    expect(validateAgentReply(reply({ design: { ...design(), objectId: "sofa-0" } }), "x")).toMatchObject({ ok: false, reason: "design has unknown field: objectId" });
    expect(validateAgentReply(reply({ design: design({ layout: { ...layout(), position: [0, 0] } }) }), "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown field: position/) });
    expect(validateAgentReply(question({ kind: "room-size", rotation: 90 }), "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown field: rotation/) });
    const missing: Record<string, unknown> = reply();
    delete missing.clarify;
    expect(validateAgentReply(missing, "x")).toMatchObject({ ok: false, reason: "reply is missing: clarify" });
  });

  it("holds the design to validateDesignIntent, and never clamps", () => {
    expect(validateAgentReply(reply({ design: design({ warmth: 1.5 }) }), "x")).toMatchObject({ ok: false, reason: "design: warmth must be between -1 and 1" });
    expect(validateAgentReply(reply({ design: design({ styles: ["BRUTALIST"] }) }), "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/^design: styles\[0\] must be one of/) });
    expect(validateAgentReply(reply({ design: design({ variantCount: 7 }) }), "x")).toMatchObject({ ok: false });
    expect(validateAgentReply(reply({ design: design({ finishes: false }) }), "x")).toMatchObject({ ok: false });
  });

  it("requires exactly the payload the route names", () => {
    expect(validateAgentReply(reply({ route: "question" }), "x")).toMatchObject({ ok: false, reason: "design must be null when the route is question" });
    expect(validateAgentReply(reply({ route: "command" }), "x")).toMatchObject({ ok: false });
    expect(validateAgentReply(reply({ design: null }), "x")).toMatchObject({ ok: false, reason: "design is required when the route is design" });
    expect(validateAgentReply(reply({ version: "agent-reply-9" }), "x")).toMatchObject({ ok: false });
    expect(validateAgentReply("design please", "x")).toMatchObject({ ok: false });
  });

  it("keeps the model's words short and plain", () => {
    expect(validateAgentReply(reply({ design: design({ atmosphere: "x".repeat(81) }) }), "x")).toMatchObject({ ok: false });
    expect(validateAgentReply(reply({ design: design({ atmosphere: "<img src=x onerror=alert(1)>" }) }), "x")).toMatchObject({ ok: false });
    expect(validateAgentReply(reply({ design: design({ atmosphere: "see https://evil.example" }) }), "x")).toMatchObject({ ok: false });
    expect(validateAgentReply(question({ kind: "object-size", subject: "the sofa\u0000" }), "x")).toMatchObject({ ok: false });
  });

  it("asks each question kind for exactly what it uses", () => {
    expect(validateAgentReply(question({ kind: "object-size" }), "x")).toMatchObject({ ok: false, reason: "question.subject is required for object-size" });
    expect(validateAgentReply(question({ kind: "room-size", subject: "the sofa" }), "x")).toMatchObject({ ok: false, reason: "question.subject must be null for room-size" });
    expect(validateAgentReply(question({ kind: "distance", subject: "the sofa" }), "x")).toMatchObject({ ok: false });
  });

  it("passes on a threshold only when the person stated it", () => {
    const text = "Is there at least 80 cm of circulation space?";
    expect(validateAgentReply(question({ kind: "circulation-at-least", metres: 0.8 }), text)).toMatchObject({ ok: true });
    expect(validateAgentReply(question({ kind: "circulation-at-least", metres: 0.9 }), text)).toMatchObject({ ok: false, reason: "question.metres must be a length stated in the request" });
    expect(validateAgentReply(question({ kind: "circulation-at-least", metres: 0.8 }), "Is there enough circulation space?")).toMatchObject({ ok: false });
    expect(validateAgentReply(question({ kind: "circulation-at-least", metres: null }), text)).toMatchObject({ ok: false });
    expect(validateAgentReply(question({ kind: "circulation-at-least", metres: 80 }), "at least 80 m?")).toMatchObject({ ok: false });
    expect(statedLengths("80 cm, 0.9 m, 2 feet and 1,5 metres")).toEqual([0.8, 0.9, 0.6096, 1.5]);
  });

  it("still rejects the live model's invalid threshold reply: a filled `other` is never trimmed", () => {
    const text = "Is there at least 80 cm of circulation space?";
    expect(validateAgentReply(question({ kind: "circulation-at-least", metres: 0.8, other: "circulation space" }), text)).toMatchObject({
      ok: false,
      reason: "question.other must be null for circulation-at-least",
    });
  });
});

describe("the threshold question, read without the model", () => {
  it("reads a stated circulation threshold from the person's own words, validated like a model's reply", () => {
    const wire = { kind: "circulation-at-least", subject: null, other: null };
    expect(readThresholdQuestion("Is there at least 80 cm of circulation space?")).toEqual({ ...wire, metres: 0.8 });
    expect(readThresholdQuestion("is there at least 0.9 m to walk through")).toEqual({ ...wire, metres: 0.9 });
    expect(readThresholdQuestion("Do the walkways have at least 3 feet?")).toEqual({ ...wire, metres: 0.9144 });
  });

  it("reads nothing else: no threshold, no length, two lengths, a count, or an absurd length", () => {
    for (const text of [
      "Is there enough circulation space?",
      "Is there at least some circulation space?",
      "Give me at least 3 layouts with better circulation",
      "Is there at least 80 cm or 90 cm of circulation?",
      "Is the sofa at least 2 m wide?",
      "Is there at least 800 m of circulation space?",
    ]) {
      expect(readThresholdQuestion(text), text).toBeNull();
    }
  });
});

describe("the prompt's question guidance", () => {
  it("routes the way in to a piece to walkway, not clearance, and keeps circulation space out of subject and other", () => {
    expect(SYSTEM_PROMPT).toMatch(/“how wide is the way in to the sofa\?”[^\n]*→ walkway, subject the piece it leads to/);
    expect(SYSTEM_PROMPT).toMatch(/clearance is only the space all around one piece/);
    expect(SYSTEM_PROMPT).toMatch(/“is there at least 80 cm of circulation space\?” → metres 0\.8; subject, other null/);
  });
});

describe("routing in agent mode", () => {
  it("fixes the two sentences the rules misroute, without changing the rules", () => {
    // Rules-only behaviour is frozen: these are what Phases 4A/4B still do.
    expect(readDesignRequest("Is there at least 80 cm of circulation space?")).toEqual({ kind: "brief" });
    expect(readDesignRequest("Make it feel like a Kyoto tea house but keep it bright")).toMatchObject({ kind: "session", action: "apply" });
    // Agent mode: a question, and a brief — never an apply.
    expect(preRoute("Is there at least 80 cm of circulation space?")).toMatchObject({ to: "agent", question: true });
    expect(preRoute("Make it feel like a Kyoto tea house but keep it bright")).toEqual({ to: "agent", rulesBrief: true, question: false });
  });

  it("keeps acts on the directions on screen, and Phase 3E commands, on the rules", () => {
    expect(preRoute("Apply the second design")).toMatchObject({ to: "session", request: { action: "apply", ordinal: 2 } });
    expect(preRoute("Preview the third layout")).toMatchObject({ to: "session", request: { action: "preview", ordinal: 3 } });
    expect(preRoute("Close the designs")).toMatchObject({ to: "session", request: { action: "dismiss" } });
    for (const command of ["Move the sofa 20cm left", "Make the room warmer", "Rotate the sofa 20 degrees", "Remove the ottoman", "Change the curtains to white", "Move the chair"]) {
      expect(preRoute(command)).toEqual({ to: "command" });
    }
  });

  it("sends questions and briefs to the agent, and says whether the rules could read the brief", () => {
    expect(preRoute("How wide is the room?")).toEqual({ to: "agent", rulesBrief: false, question: true });
    expect(preRoute("how much walkable floor is there")).toEqual({ to: "agent", rulesBrief: false, question: true });
    expect(preRoute("Give me 3 modern designs")).toEqual({ to: "agent", rulesBrief: true, question: false });
    expect(preRoute("Give me three furniture layouts.")).toEqual({ to: "agent", rulesBrief: true, question: false });
    expect(preRoute("I want the room to work better for movie nights")).toEqual({ to: "command" });
  });
});

describe("the room brief", () => {
  const brief = roomBrief(ROOM, EVIDENCE);

  it("is the same text every time, for the same room", () => {
    expect(roomBrief(ROOM, EVIDENCE)).toBe(brief);
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT.slice());
  });

  it("names pieces by label and holds no Scene id, path or pixel", () => {
    for (const o of ROOM.objects) {
      expect(brief).toContain(o.label);
      expect(brief).not.toMatch(new RegExp(`\\b${o.id}\\b`));
    }
    // Ids that are also plain words ("floor", "ceiling") are words there, not ids.
    const ids = [ROOM.id, ...ROOM.openings.map((o) => o.id), ...ROOM.surfaces.map((s) => s.id), ...ROOM.materials.map((m) => m.id)].filter((id) => /[-\d]/.test(id));
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) expect(brief).not.toContain(id);
    expect(brief).not.toMatch(/[A-Za-z]:\\|\/home\/|runs\/|\.png|\.jpg|data:image/);
  });

  it("gives Phase 5's honest numbers, with how they are known", () => {
    expect(brief).toContain("≈ 3.7 × 6.4 × 3.0 m");
    expect(brief).toMatch(/Free floor \(not under furniture\): ≈ 18 m² \(default\)/);
    expect(brief).toMatch(/Circulation area .*: ≈ 7\.5 m²/);
    expect(brief).toContain("Glazed door");
    // No raw, over-precise values.
    expect(brief).not.toMatch(/\d\.\d{3}/);
  });

  it("stays well inside its size limit", () => {
    expect(brief.length).toBeLessThan(8000);
  });
});
