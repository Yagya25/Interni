import { describe, expect, it } from "vitest";
import { readBrief, readDesignRequest } from "../design/read";
import { readThresholdQuestion } from "./question";
import { SYSTEM_PROMPT } from "./prompt";
import { preRoute } from "./route";
import { AGENT_REPLY_SCHEMA } from "./schema";
import { AGENT_REPLY_VERSION, DIRECTION_KINDS, MAX_CHECKS, QUESTION_KINDS } from "./types";
import { validateAgentReply } from "./validate";

/**
 * Phase 9's additions to the reply contract (agent-reply-0.2): a question
 * about the directions on screen, and checks on a design's new directions.
 * Phase 6's own tests (agent.boundary.test.ts) run unchanged on 0.1 replies.
 */

const design = readBrief("Give me three furniture layouts") as Record<string, unknown>;
const q = (over: Record<string, unknown> = {}) => ({ kind: "free-floor", subject: null, other: null, metres: null, ...over });
const reply = (over: Record<string, unknown> = {}) => ({
  version: "agent-reply-0.2",
  route: "design",
  design,
  checks: null,
  question: null,
  directions: null,
  clarify: null,
  outOfScope: null,
  ...over,
});
const asks = (question: Record<string, unknown>, directions: unknown = null) => reply({ route: "question", design: null, question, directions });

describe("the 0.2 reply schema", () => {
  it("is what the model is asked for, built from the code's own vocabulary", () => {
    expect(AGENT_REPLY_VERSION).toBe("agent-reply-0.2");
    const props = AGENT_REPLY_SCHEMA.properties as Record<string, { anyOf: { type: string; items?: { properties?: Record<string, { enum?: unknown }>; type?: string } }[] }>;
    expect(Object.keys(props)).toEqual(["version", "route", "design", "checks", "question", "directions", "clarify", "outOfScope"]);
    expect((props.version as unknown as { enum: string[] }).enum).toEqual(["agent-reply-0.2"]);
    // A check is a question of a kind a direction can change; a question may be any kind.
    expect(props.checks.anyOf[0].items!.properties!.kind.enum).toEqual([...DIRECTION_KINDS]);
    expect((props.question.anyOf[0] as unknown as { properties: Record<string, { enum: unknown }> }).properties.kind.enum).toEqual([...QUESTION_KINDS]);
    expect(props.directions.anyOf[0]).toEqual({ type: "array", items: { type: "integer" } });
  });

  it("measures on directions only what a direction can change: never a size", () => {
    expect(DIRECTION_KINDS).toEqual(["free-floor", "circulation-area", "walkway", "distance", "circulation-at-least"]);
    for (const size of ["room-size", "object-size"]) expect(DIRECTION_KINDS).not.toContain(size);
  });
});

describe("validateAgentReply, 0.2", () => {
  it("accepts every 0.1 route in 0.2, with the additions null, as the same reply", () => {
    const v01 = { version: "agent-reply-0.1", route: "design", design, question: null, clarify: null, outOfScope: null };
    expect(validateAgentReply(reply(), "x")).toEqual(validateAgentReply(v01, "x"));
    expect(validateAgentReply(asks(q({ kind: "room-size" })), "x")).toEqual({ ok: true, reply: { route: "question", question: q({ kind: "room-size" }) } });
    expect(validateAgentReply(reply({ route: "command", design: null }), "x")).toEqual({ ok: true, reply: { route: "command" } });
    expect(validateAgentReply(reply({ route: "clarify", design: null, clarify: "too-vague" }), "x")).toMatchObject({ ok: true });
    expect(validateAgentReply(reply({ route: "out_of_scope", design: null, outOfScope: "image" }), "x")).toMatchObject({ ok: true });
  });

  it("holds each version to its own key set: no 0.2 field in 0.1, and every 0.2 field required", () => {
    const v01 = { version: "agent-reply-0.1", route: "design", design, question: null, clarify: null, outOfScope: null };
    expect(validateAgentReply({ ...v01, checks: null }, "x")).toEqual({ ok: false, reason: "reply has unknown field: checks" });
    expect(validateAgentReply({ ...v01, directions: [1] }, "x")).toEqual({ ok: false, reason: "reply has unknown field: directions" });
    const missing: Record<string, unknown> = reply();
    delete missing.directions;
    expect(validateAgentReply(missing, "x")).toEqual({ ok: false, reason: "reply is missing: directions" });
    expect(validateAgentReply({ ...reply(), objectId: "sofa-0" }, "x")).toEqual({ ok: false, reason: "reply has unknown field: objectId" });
    expect(validateAgentReply(reply({ version: "agent-reply-0.3" }), "x")).toMatchObject({ ok: false });
  });

  it("reads a question about directions on screen, by their numbers", () => {
    expect(validateAgentReply(asks(q(), [1, 2, 3]), "Which layout leaves the most free floor?")).toEqual({ ok: true, reply: { route: "question", question: q(), directions: [1, 2, 3] } });
    const walk = q({ kind: "walkway", subject: "the sofa" });
    expect(validateAgentReply(asks(walk, [2]), "How wide is the way to the sofa in the second one?")).toEqual({ ok: true, reply: { route: "question", question: walk, directions: [2] } });
    const text = "Does the first layout keep at least 80 cm of circulation?";
    expect(validateAgentReply(asks(q({ kind: "circulation-at-least", metres: 0.8 }), [1]), text)).toMatchObject({ ok: true });
  });

  it("refuses directions that are not whole numbers from 1 to 3, repeated, empty, or with a size question", () => {
    const at = (directions: unknown, question = q()) => validateAgentReply(asks(question, directions), "x");
    expect(at([])).toEqual({ ok: false, reason: "directions must be a non-empty list of numbers, or null" });
    expect(at("all")).toMatchObject({ ok: false, reason: "directions must be a non-empty list of numbers, or null" });
    expect(at([0])).toEqual({ ok: false, reason: "directions[0] must be a whole number from 1 to 3" });
    expect(at([4])).toMatchObject({ ok: false });
    expect(at([1.5])).toMatchObject({ ok: false });
    expect(at(["1"])).toMatchObject({ ok: false });
    expect(at([1, 1])).toEqual({ ok: false, reason: "directions must not repeat" });
    expect(at([1], q({ kind: "room-size" }))).toEqual({
      ok: false,
      reason: "question.kind must be one of free-floor, circulation-area, walkway, distance, circulation-at-least when it asks about directions",
    });
    expect(at([1], q({ kind: "object-size", subject: "the sofa" }))).toMatchObject({ ok: false });
    expect(at([1], q({ kind: "clearance", subject: "the sofa" }))).toMatchObject({ ok: false });
  });

  it("reads checks on a design's new directions, one to three, none repeated", () => {
    const text = "Give me three layouts that keep at least 80 cm of circulation, and tell me which leaves the most free floor";
    const checks = [q({ kind: "circulation-at-least", metres: 0.8 }), q()];
    expect(validateAgentReply(reply({ checks }), text)).toMatchObject({ ok: true, reply: { route: "design", checks } });
    expect(validateAgentReply(reply({ checks: [] }), text)).toEqual({ ok: false, reason: "checks must be null when there are none" });
    expect(validateAgentReply(reply({ checks: [q(), q()] }), text)).toEqual({ ok: false, reason: "checks must not repeat" });
    const many = [q(), q({ kind: "circulation-area" }), q({ kind: "walkway", subject: "the sofa" }), q({ kind: "distance", subject: "the sofa", other: "the coffee table" })];
    expect(many).toHaveLength(MAX_CHECKS + 1);
    expect(validateAgentReply(reply({ checks: many }), text)).toEqual({ ok: false, reason: "checks must hold at most 3" });
    expect(validateAgentReply(reply({ checks: q() }), text)).toEqual({ ok: false, reason: "checks must be a list, or null" });
  });

  it("holds every check to the question rules: its kind, its fields, plain words and a stated threshold", () => {
    const text = "Three layouts with at least 80 cm of circulation";
    const check = (c: Record<string, unknown>) => validateAgentReply(reply({ checks: [q(c)] }), text);
    expect(check({ kind: "room-size" })).toEqual({ ok: false, reason: "checks[0].kind must be one of free-floor, circulation-area, walkway, distance, circulation-at-least" });
    expect(check({ kind: "walkway" })).toEqual({ ok: false, reason: "checks[0].subject is required for walkway" });
    expect(check({ kind: "free-floor", subject: "the sofa" })).toEqual({ ok: false, reason: "checks[0].subject must be null for free-floor" });
    expect(check({ kind: "circulation-at-least", metres: 0.9 })).toEqual({ ok: false, reason: "checks[0].metres must be a length stated in the request" });
    expect(check({ kind: "walkway", subject: "<b>sofa</b>" })).toEqual({ ok: false, reason: "checks[0].subject must be plain words" });
    expect(check({ kind: "free-floor", objectId: "sofa-0" })).toEqual({ ok: false, reason: "checks[0] has unknown field: objectId" });
  });

  it("keeps checks with designs and directions with questions", () => {
    expect(validateAgentReply(asks(q(), null), "x")).toMatchObject({ ok: true });
    expect(validateAgentReply(reply({ route: "question", design: null, question: q(), checks: [q()] }), "x")).toEqual({ ok: false, reason: "checks must be null when the route is question" });
    expect(validateAgentReply(reply({ directions: [1] }), "x")).toEqual({ ok: false, reason: "directions must be null when the route is design" });
    expect(validateAgentReply(reply({ route: "command", design: null, directions: [1] }), "x")).toMatchObject({ ok: false });
  });

  it("still reads the threshold question without the model, in the current version", () => {
    expect(readThresholdQuestion("Is there at least 80 cm of circulation space?")).toEqual({ kind: "circulation-at-least", subject: null, other: null, metres: 0.8 });
  });
});

describe("routing in agent mode, Phase 9", () => {
  const onScreen = { to: "agent", rulesBrief: false, question: false, onScreen: true };

  it("sends a direction named to be measured or compared to the agent, not to a preview — without changing the rules", () => {
    for (const text of ["Check the second one", "Compare the first and second designs", "Measure the third layout", "Test the first design"]) {
      // Rules-only behaviour is frozen: these are still read as a preview there.
      expect(readDesignRequest(text), text).toMatchObject({ kind: "session", action: "preview" });
      expect(preRoute(text), text).toEqual(onScreen);
    }
  });

  it("keeps every explicit act on the directions on screen on the rules", () => {
    expect(preRoute("Apply the second design")).toMatchObject({ to: "session", request: { action: "apply", ordinal: 2 } });
    expect(preRoute("Apply the second one and check it")).toMatchObject({ to: "session", request: { action: "apply", ordinal: 2 } });
    expect(preRoute("Preview the third layout")).toMatchObject({ to: "session", request: { action: "preview", ordinal: 3 } });
    expect(preRoute("Show me the second one and check it")).toMatchObject({ to: "session", request: { action: "preview", ordinal: 2 } });
    expect(preRoute("the second one")).toMatchObject({ to: "session", request: { action: "preview", ordinal: 2 } });
    expect(preRoute("Close the designs")).toMatchObject({ to: "session", request: { action: "dismiss" } });
  });

  it("leaves Phase 6's routes for questions, briefs and commands as they were", () => {
    expect(preRoute("Which layout leaves the most free floor?")).toMatchObject({ to: "agent", question: true });
    expect(preRoute("Which layout leaves the most free floor?")).not.toHaveProperty("onScreen");
    expect(preRoute("Compare the three layouts")).toEqual({ to: "agent", rulesBrief: true, question: false });
    expect(preRoute("Give me three layouts that keep at least 80 cm of circulation")).toEqual({ to: "agent", rulesBrief: true, question: false });
    for (const command of ["Move the sofa 20cm left", "Check the sofa", "Make the room warmer"]) expect(preRoute(command), command).toEqual({ to: "command" });
  });
});

describe("the prompt's Phase 9 guidance", () => {
  it("names the kinds a direction can change, the check limit, and what the model never does", () => {
    expect(SYSTEM_PROMPT).toContain(`Only these question kinds can differ between directions: ${DIRECTION_KINDS.join(", ")}.`);
    expect(SYSTEM_PROMPT).toMatch(/- directions: null unless the question is about directions on screen/);
    expect(SYSTEM_PROMPT).toContain(`Then 1 to ${MAX_CHECKS} questions in the question format`);
    expect(SYSTEM_PROMPT).toContain("You never preview, apply, rank or score a direction, and you never say which is best.");
    expect(SYSTEM_PROMPT).toContain(`Always set version to "agent-reply-0.2".`);
  });

  it("says checks come on top of a design, and its worked example is a reply the validator accepts", () => {
    // Found live: Groq answered a checked layout request with finishes false and layout null, which the
    // frozen intent rules refuse ("asks for neither finishes nor a layout").
    expect(SYSTEM_PROMPT).toContain("Checks come on top of the design, never instead of it");
    expect(SYSTEM_PROMPT).toContain("“Keep at least 80 cm” is a check: it never sets layout.preserve and never leaves layout null.");
    const text = "Give me three furniture layouts that keep at least 80 cm of circulation space";
    expect(SYSTEM_PROMPT).toContain(`“${text}” → design with finishes false, variantCount 3 and layout set (styles empty, every layout axis null, preserve false), and checks [circulation-at-least, metres 0.8].`);
    const example = reply({
      design: { ...design, variantCount: 3, finishes: false, layout: { styles: [], social: null, tvFocus: null, openness: null, circulation: null, symmetry: null, compactness: null, separation: null, preserve: false } },
      checks: [q({ kind: "circulation-at-least", metres: 0.8 })],
    });
    expect(validateAgentReply(example, text)).toMatchObject({ ok: true, reply: { route: "design", checks: [{ kind: "circulation-at-least", metres: 0.8 }] } });
    // What the live model sent instead is refused, with the reason it was given to repair from.
    const live = reply({ design: { ...design, variantCount: 3, finishes: false, layout: null }, checks: [q({ kind: "circulation-at-least", metres: 0.8 })] });
    expect(validateAgentReply(live, text)).toEqual({ ok: false, reason: "design: the intent asks for neither finishes nor a layout" });
  });

  it("says a direction already on screen is asked about with directions, never checks, and its worked example is a valid reply", () => {
    // Found live: Groq sometimes answered “check the second one…” as a new design with a check.
    expect(SYSTEM_PROMPT).toContain("Checks are only for new directions being asked for.");
    const text = "Check the second one for 80 cm to every seat";
    expect(SYSTEM_PROMPT).toContain(`“${text}” → question circulation-at-least, metres 0.8, directions [2].`);
    expect(validateAgentReply(asks(q({ kind: "circulation-at-least", metres: 0.8 }), [2]), `${text}.`)).toEqual({
      ok: true,
      reply: { route: "question", question: q({ kind: "circulation-at-least", metres: 0.8 }), directions: [2] },
    });
  });
});
