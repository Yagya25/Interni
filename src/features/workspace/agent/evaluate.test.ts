import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { applyOperations } from "@/scene/model/operations";
import { validateDesignIntent } from "../design/intent";
import { readBrief } from "../design/read";
import { fromIntent } from "../design/session";
import { answer, type Measurement } from "../measure";
import { checkDirections, compare, directionsNote, evaluateDirections, exceeds, type Reading } from "./evaluate";
import type { DirectionQuestion } from "./types";

const FIXTURE = new URL("../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);
const parsed = parseIntermediate(JSON.parse(readFileSync(FIXTURE, "utf8")));
if (parsed.kind !== "run") throw new Error("fixture");
const compiled = compileRoomShell(parsed.intermediate);
if (!compiled.ok) throw new Error("compile");
const { scene: ROOM, evidence: EVIDENCE } = compiled;
const ORIGINAL = JSON.stringify(ROOM);

function directionsFor(text: string) {
  const intent = validateDesignIntent(readBrief(text));
  if (!intent.ok) throw new Error(intent.reason);
  const out = fromIntent(text, intent.intent, ROOM);
  if (out.outcome !== "designs") throw new Error("no designs");
  return out.session.proposals.map((proposal, i) => ({ ordinal: i + 1, proposal }));
}
const LAYOUTS = directionsFor("Give me three furniture layouts");
const FINISHES = directionsFor("Give me 3 modern designs");

const q = (kind: DirectionQuestion["kind"], over: Partial<DirectionQuestion> = {}): DirectionQuestion => ({ kind, subject: null, other: null, metres: null, ...over }) as DirectionQuestion;
const context = { room: ROOM, shown: ROOM, evidence: EVIDENCE, selectionId: null };
const evaluate = (question: DirectionQuestion, directions = LAYOUTS) => {
  const e = evaluateDirections({ ...context, question, directions });
  if (!e.ok) throw new Error(`not evaluated: ${e.result.kind}`);
  return e;
};

describe("measuring a direction", () => {
  it("is Phase 5's own answer on the room with the direction laid over it, exactly as Preview lays it", () => {
    expect(LAYOUTS.map((d) => d.proposal.title)).toEqual(["Around the television", "Conversation around the coffee table", "Open floor"]);
    for (const question of [q("free-floor"), q("circulation-area"), q("walkway", { subject: "the sofa" }), q("distance", { subject: "the sofa", other: "the coffee table" }), q("circulation-at-least", { metres: 0.8 })]) {
      const e = evaluate(question);
      e.readings.forEach((r, i) => {
        // The renderer's own derivation of a previewed direction (`renderedScene` in the store).
        const previewed = applyOperations(ROOM, LAYOUTS[i].proposal.operations);
        expect(r.answer).toEqual(answer(previewed, EVIDENCE, e.question));
        expect(r.ordinal).toBe(i + 1);
        expect(r.proposalId).toBe(LAYOUTS[i].proposal.id);
      });
      expect(e.now.answer).toEqual(answer(ROOM, EVIDENCE, e.question));
    }
  });

  it("never writes to the room or to a proposal", () => {
    const proposals = JSON.stringify(LAYOUTS.map((d) => d.proposal));
    for (const question of [q("free-floor"), q("circulation-at-least", { metres: 0.8 }), q("walkway", { subject: "the sofa" })]) evaluate(question);
    checkDirections(LAYOUTS.map((d) => d.proposal), [q("circulation-area")], context);
    expect(JSON.stringify(ROOM)).toBe(ORIGINAL);
    expect(JSON.stringify(LAYOUTS.map((d) => d.proposal))).toBe(proposals);
  });

  it("gives the same readings and words every time", () => {
    for (const question of [q("circulation-area"), q("circulation-at-least", { metres: 0.8 })]) {
      const a = evaluate(question);
      const b = evaluate(question);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(directionsNote(b, ROOM)).toBe(directionsNote(a, ROOM));
    }
  });

  it("reads directions in the order of their numbers, whatever order they are named in", () => {
    const e = evaluate(q("circulation-area"), [LAYOUTS[2], LAYOUTS[0]]);
    expect(e.readings.map((r) => r.ordinal)).toEqual([1, 3]);
  });

  it("marks a layout's floor readings as edited, and leaves a finish direction's as found", () => {
    const layout = evaluate(q("circulation-area"));
    expect(layout.readings.every((r) => r.value!.edited)).toBe(true);
    expect(layout.now.value!.edited).toBe(false);
    const finish = evaluate(q("circulation-area"), FINISHES);
    expect(finish.readings.every((r) => !r.value!.edited && r.value!.value === finish.now.value!.value)).toBe(true);
  });

  it("resolves names as Phase 6 does: a name that fits several is asked back, never guessed", () => {
    const e = evaluateDirections({ ...context, question: q("walkway", { subject: "the chair" }), directions: LAYOUTS });
    expect(e).toMatchObject({ ok: false, result: { kind: "clarify", message: "I found 3 chairs. Which one do you mean?" } });
    if (e.ok || e.result.kind !== "clarify") throw new Error("expected a question back");
    expect(e.result.options.map((o) => o.label)).toEqual(["Chair", "Armchair 1", "Armchair 2"]);
    const missing = evaluateDirections({ ...context, question: q("walkway", { subject: "the piano" }), directions: LAYOUTS });
    expect(missing).toMatchObject({ ok: false, result: { kind: "none" } });
    // With the piece selected, "this chair" is that piece.
    const selected = evaluateDirections({ ...context, selectionId: "armchair-1", question: q("walkway", { subject: "this chair" }), directions: LAYOUTS });
    expect(selected).toMatchObject({ ok: true, label: "Way to Armchair 2" });
  });
});

describe("comparing directions, under Phase 5's rounding contract", () => {
  const m = (value: number, resolution: number, bound: Measurement["bound"] = "value") =>
    ({ value, resolution, rounded: Math.round(value / resolution) * resolution, bound }) as Measurement;
  const r = (title: string, value: Measurement | null) => ({ title, value }) as Reading;

  it("tells two values apart only by at least the coarser step, with different rounded values, and never above a lower bound", () => {
    expect(exceeds(m(8.95, 0.5), m(7.83, 0.5))).toBe(true);
    expect(exceeds(m(7.83, 0.5), m(7.8, 0.5))).toBe(false); // same rounded value
    expect(exceeds(m(8.2, 0.5), m(7.8, 0.5))).toBe(false); // rounded 8 vs 8
    expect(exceeds(m(8.3, 0.5), m(7.9, 0.5))).toBe(false); // rounded 8.5 vs 8, but less than a step apart
    expect(exceeds(m(0.62, 0.05), m(0.55, 0.05))).toBe(true);
    expect(exceeds(m(0.62, 0.1), m(0.55, 0.05))).toBe(false); // within the coarser step
    expect(exceeds(m(1.4, 0.1), m(0.55, 0.05, "at-least"))).toBe(false); // the smaller could be more
    expect(exceeds(m(1.4, 0.1, "at-least"), m(0.55, 0.05))).toBe(true); // the larger is at least this
    expect(exceeds(m(7.8, 0.5), m(8.95, 0.5))).toBe(false);
  });

  it("names a most or a least only when one direction stands apart from every other", () => {
    expect(compare([r("A", m(9, 0.5)), r("B", m(8, 0.5))])).toMatchObject({ kind: "apart", most: { title: "A" }, least: { title: "B" } });
    expect(compare([r("A", m(9, 0.5)), r("B", m(7.8, 0.5)), r("C", m(7.9, 0.5))])).toMatchObject({ kind: "apart", most: { title: "A" }, least: null });
    expect(compare([r("A", m(9, 0.5)), r("B", m(9.1, 0.5)), r("C", m(7, 0.5))])).toMatchObject({ kind: "apart", most: null, least: { title: "C" } });
    // A stands apart from C but not from B, and B not from C: no one direction stands apart from all.
    expect(exceeds(m(9, 0.5), m(8.4, 0.5))).toBe(true);
    expect(compare([r("A", m(9, 0.5)), r("B", m(8.7, 0.5)), r("C", m(8.4, 0.5))])).toEqual({ kind: "indistinct" });
    expect(compare([r("A", m(9, 0.5)), r("B", m(9, 0.5))])).toEqual({ kind: "indistinct" });
    // Nothing to compare: one value, or values that could not be measured.
    expect(compare([r("A", m(9, 0.5))])).toEqual({ kind: "none" });
    expect(compare([r("A", m(9, 0.5)), r("B", null)])).toEqual({ kind: "none" });
  });

  it("on the real room: Open floor leaves the most circulation area, and the other two cannot be told apart", () => {
    const e = evaluate(q("circulation-area"));
    expect(e.readings.map((x) => x.value!.rounded)).toEqual([8, 8, 9]);
    expect(e.comparison).toMatchObject({ kind: "apart", most: { title: "Open floor" }, least: null });
    expect(directionsNote(e, ROOM)).toBe(
      "Circulation area, with each direction laid over the room as its preview shows it: now ≈ 7.5 m² (default); 1. Around the television ≈ 8 m² (default, as edited); 2. Conversation around the coffee table ≈ 8 m² (default, as edited); 3. Open floor ≈ 9 m² (default, as edited). Open floor leaves the most circulation area; the others cannot be meaningfully told apart. Not calibrated: every length shares one unknown scale error.",
    );
  });

  it("on the real room: says plainly when no direction can be told apart", () => {
    const e = evaluate(q("free-floor"));
    expect(e.comparison).toEqual({ kind: "indistinct" });
    expect(directionsNote(e, ROOM)).toContain("No one direction can be meaningfully told apart from all the others on free floor: the differences are within the steps the values are known to.");
    const finishes = evaluate(q("circulation-area"), FINISHES);
    expect(finishes.comparison).toEqual({ kind: "indistinct" });
  });

  it("never scores, ranks or calls a direction best", () => {
    const words = [q("free-floor"), q("circulation-area"), q("walkway", { subject: "the sofa" }), q("circulation-at-least", { metres: 0.8 })]
      .map((question) => directionsNote(evaluate(question), ROOM))
      .join(" ");
    expect(words).not.toMatch(/\b(best|worst|better|score|scored|rank|ranked|rating|recommend)/i);
  });

  it("gives a threshold's verdicts, Phase 5's own, rather than a comparison", () => {
    const e = evaluate(q("circulation-at-least", { metres: 0.8 }));
    expect(e.comparison).toEqual({ kind: "none" });
    expect(e.readings.map((x) => x.verdict)).toEqual(["no", "no", "too-close-to-call"]);
    expect(e.readings.map((x) => x.verdict)).toEqual(e.readings.map((x) => (x.answer.ok ? x.answer.verdict : null)));
    expect(directionsNote(e, ROOM)).toContain("3. Open floor: too close to call (narrowest ≈ 0.8 m, inferred, as edited)");
  });
});

describe("the words for one direction", () => {
  it("are Phase 5's own sentence, measured on that direction", () => {
    const e = evaluate(q("walkway", { subject: "the sofa" }), [LAYOUTS[2]]);
    const previewed = applyOperations(ROOM, LAYOUTS[2].proposal.operations);
    const own = answer(previewed, EVIDENCE, e.question);
    if (!own.ok) throw new Error("expected an answer");
    expect(directionsNote(e, ROOM)).toBe(`3. Open floor, laid over the room as its preview shows it: ${own.text}`);
  });
});

describe("checks on a design's directions", () => {
  const proposals = LAYOUTS.map((d) => d.proposal);

  it("gives each direction one short line per check, and leaves the proposals exactly as they were", () => {
    const before = proposals.map((p) => JSON.stringify(p));
    const checked = checkDirections(proposals, [q("circulation-at-least", { metres: 0.8 }), q("circulation-area")], context);
    expect(proposals.map((p) => JSON.stringify(p))).toEqual(before);
    expect(checked.checks.map((c) => c.label)).toEqual(["At least 80 cm to every seat", "Circulation area"]);
    for (const check of checked.checks) {
      expect(check.measuredOn).toBe(ROOM);
      expect(check.results.map((x) => x.proposalId)).toEqual(proposals.map((p) => p.id));
    }
    expect(checked.checks[0].results.map((x) => [x.text, x.verdict])).toEqual([
      ["At least 80 cm to every seat: no (narrowest ≈ 0.55 m)", "no"],
      ["At least 80 cm to every seat: no (narrowest ≈ 0.55 m)", "no"],
      ["At least 80 cm to every seat: too close to call (narrowest ≈ 0.8 m)", "too-close-to-call"],
    ]);
    expect(checked.checks[1].results.map((x) => x.text)).toEqual(["Circulation area ≈ 8 m²", "Circulation area ≈ 8 m²", "Circulation area ≈ 9 m²"]);
    expect(checked.note).toBe(
      "Measured on each new direction: At least 80 cm to every seat: no for 1 and 2; too close to call for 3. Open floor leaves the most circulation area; the others cannot be meaningfully told apart. Not calibrated: every length shares one unknown scale error.",
    );
  });

  it("names the pieces when a check's name fits several, and still checks the rest", () => {
    const checked = checkDirections(proposals, [q("walkway", { subject: "the chair" }), q("free-floor")], context);
    expect(checked.checks.map((c) => c.label)).toEqual(["Free floor"]);
    expect(checked.note).toContain("Not checked — more than one piece fits (Chair, Armchair 1, Armchair 2): name one to check it.");
  });

  it("says a single direction's value, with its basis, when there is nothing to compare it with", () => {
    const checked = checkDirections([proposals[2]], [q("circulation-area")], context);
    expect(checked.note).toBe("Measured on each new direction: Circulation area: ≈ 9 m² (default, as edited). Not calibrated: every length shares one unknown scale error.");
  });
});
