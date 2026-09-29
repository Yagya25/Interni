import type { SceneEvidence } from "@/scene/compile/evidence";
import { applyOperations } from "@/scene/model/operations";
import { findById } from "@/scene/model/queries";
import type { Id, Scene } from "@/scene/model/types";
import type { DesignProposal } from "../design/proposal";
import type { DirectionCheck } from "../design/session";
import { answer, basisOf, formatMeasurement, knowledgeOf, measureScene, type Measurement, type SpatialAnswer, type SpatialQuestion, type Verdict } from "../measure";
import { AGENT_MESSAGES } from "./messages";
import { spatialQuestionOf, type Unanswered } from "./question";
import type { DirectionQuestion } from "./types";

/**
 * Measuring the directions on screen (Phase 9).
 * ================================================================
 *
 * Each direction is laid over the room exactly as Preview lays it —
 * `applyOperations(room, proposal.operations)`, the renderer's own
 * derivation — and asked a Phase 5 question with Phase 5's `answer()`.
 * Every number, verdict and word of basis is Phase 5's, and so is the
 * rounding. Nothing here writes to a Scene, a proposal or the history.
 *
 * Comparing two values is Phase 5's rounding contract applied to both: one
 * direction reads more than another only when the difference is at least
 * the coarser of their two steps, their rounded values differ, and the
 * smaller is not a lower bound (it could be more). Otherwise the two cannot
 * be meaningfully told apart, and that is what is said. A most or a least is
 * named only when one direction stands apart from every other; nothing is
 * scored, ranked or called best.
 */

export interface Direction {
  /** Its number on screen, from 1. */
  ordinal: number;
  proposal: DesignProposal;
}

export interface Reading {
  /** The direction's number on screen, or null for the room as it is. */
  ordinal: number | null;
  proposalId: string | null;
  title: string;
  /** Phase 5's answer, on this arrangement. */
  answer: SpatialAnswer;
  /** The one value compared: the free floor, the circulation area, the way's width, the distance, or the narrowest way to a seat. */
  value: Measurement | null;
  verdict: Verdict | null;
}

export type Evaluation =
  | {
      ok: true;
      question: SpatialQuestion;
      /** What was measured, in the person's terms. */
      label: string;
      /** The room as it is, without any direction laid over it. */
      now: Reading;
      /** One per direction, in the order of their numbers. */
      readings: readonly Reading[];
      comparison: Comparison;
      /** Said once, after the values: how every length in the room is known. */
      scaleNote: string;
    }
  | { ok: false; result: Unanswered };

export type Comparison =
  /** Fewer than two values to compare, or a verdict rather than a value. */
  | { kind: "none" }
  /** At least one of a most and a least stands apart from every other direction. */
  | { kind: "apart"; most: Reading | null; least: Reading | null }
  /** No direction stands apart from all the others. */
  | { kind: "indistinct" };

export interface EvaluationInput {
  question: DirectionQuestion;
  /** The document's room: each direction is laid over it, as Preview lays it. */
  room: Scene;
  /** The room as the person sees it: names are resolved there, as Phase 6 resolves them. */
  shown: Scene;
  evidence: SceneEvidence | null;
  selectionId: Id | null;
  directions: readonly Direction[];
}

export function evaluateDirections(input: EvaluationInput): Evaluation {
  const resolved = spatialQuestionOf(input.question, input.shown, input.selectionId);
  if (!resolved.ok) return resolved;
  const question = resolved.question;
  const read = (scene: Scene, ordinal: number | null, proposal: DesignProposal | null): Reading => {
    const a = answer(scene, input.evidence, question);
    return {
      ordinal,
      proposalId: proposal?.id ?? null,
      title: proposal?.title ?? AGENT_MESSAGES.directions.now,
      answer: a,
      value: valueOf(question, a),
      verdict: a.ok ? (a.verdict ?? null) : null,
    };
  };
  const directions = [...input.directions].sort((a, b) => a.ordinal - b.ordinal);
  const readings = directions.map((d) => read(applyOperations(input.room, d.proposal.operations), d.ordinal, d.proposal));
  const m = measureScene(input.room, knowledgeOf(input.room, input.evidence).evidence);
  return {
    ok: true,
    question,
    label: labelOf(question, input.room),
    now: read(input.room, null, null),
    readings,
    comparison: question.kind === "circulation-at-least" ? { kind: "none" } : compare(readings),
    scaleNote: m.scale?.basis === "estimated" ? AGENT_MESSAGES.directions.uncalibrated : m.source === "authored" ? AGENT_MESSAGES.directions.authored : "",
  };
}

/** The value a question is about, from Phase 5's own answer. */
function valueOf(question: SpatialQuestion, a: SpatialAnswer): Measurement | null {
  if (!a.ok || a.measurements.length === 0) return null;
  // "At least …" measures the way to every seat; what decides it is the narrowest.
  if (question.kind === "circulation-at-least") return a.measurements.reduce((x, y) => (y.value < x.value ? y : x));
  return a.measurements[0];
}

/** Whether `a` reads meaningfully more than `b`, under Phase 5's rounding contract. */
export function exceeds(a: Measurement, b: Measurement): boolean {
  return a.rounded !== b.rounded && a.value - b.value >= Math.max(a.resolution, b.resolution) && b.bound !== "at-least";
}

export function compare(readings: readonly Reading[]): Comparison {
  const valued = readings.filter((r) => r.value !== null);
  if (valued.length < 2) return { kind: "none" };
  const most = valued.find((r) => valued.every((o) => o === r || exceeds(r.value!, o.value!))) ?? null;
  const least = valued.find((r) => valued.every((o) => o === r || exceeds(o.value!, r.value!))) ?? null;
  return most || least ? { kind: "apart", most, least } : { kind: "indistinct" };
}

// ---------------------------------------------------------------------------
// Words: every sentence is built from Phase 5's numbers and fixed phrases.

const pieceName = (scene: Scene, id: Id) => findById(scene.objects, id)?.label ?? findById(scene.openings, id)?.label ?? id;

function labelOf(q: SpatialQuestion, scene: Scene): string {
  switch (q.kind) {
    case "free-floor":
      return "Free floor";
    case "circulation-area":
      return "Circulation area";
    case "walkway":
      return `Way to ${pieceName(scene, q.objectId)}`;
    case "distance":
      return `${pieceName(scene, q.from)} to ${pieceName(scene, q.to)}`;
    case "circulation-at-least":
      return `At least ${Math.round(q.metres * 100)} cm to every seat`;
    default:
      return q.kind;
  }
}

/** What "most" and "least" mean for a question, as whole phrases, and what the values are of. */
function phrasesOf(q: SpatialQuestion, scene: Scene): { most: string; least: string; topic: string } {
  switch (q.kind) {
    case "free-floor":
      return { most: "leaves the most free floor", least: "leaves the least free floor", topic: "free floor" };
    case "circulation-area":
      return { most: "leaves the most circulation area", least: "leaves the least circulation area", topic: "circulation area" };
    case "walkway": {
      const to = pieceName(scene, q.objectId);
      return { most: `leaves the widest way to ${to}`, least: `leaves the narrowest way to ${to}`, topic: `the way to ${to}` };
    }
    case "distance": {
      const pair = `${pieceName(scene, q.from)} and ${pieceName(scene, q.to)}`;
      return { most: `sets ${pair} farthest apart`, least: `sets ${pair} closest together`, topic: `the distance between ${pair}` };
    }
    default:
      return { most: "", least: "", topic: q.kind };
  }
}

const W = AGENT_MESSAGES.directions;

/** One reading's value in words: "≈ 18 m² (default, as edited)", "no (narrowest ≈ 0.55 m, estimated)". */
function valueText(r: Reading, threshold: boolean, withBasis: boolean): string {
  if (!r.answer.ok) return W.unmeasured;
  const basis = (m: Measurement) => (withBasis ? `, ${basisOf(m)}` : "");
  if (threshold) {
    const word = W.verdict[r.verdict ?? "no"];
    if (!r.value) return `${word} (${W.unreachable})`;
    return `${word} (${W.narrowest} ${formatMeasurement(r.value)}${basis(r.value)})`;
  }
  if (!r.value) return W.unmeasured;
  return withBasis ? `${formatMeasurement(r.value)} (${basisOf(r.value)})` : formatMeasurement(r.value);
}

/** The sentence a comparison says, or "" when there is nothing to compare. */
export function comparisonText(e: Extract<Evaluation, { ok: true }>, room: Scene): string {
  const c = e.comparison;
  if (c.kind === "none") return "";
  const p = phrasesOf(e.question, room);
  if (c.kind === "indistinct") return W.indistinct(p.topic);
  if (c.most && c.least) return `${c.most.title} ${p.most}, and ${c.least.title} ${p.least}.`;
  if (c.most) return `${c.most.title} ${p.most}; ${W.others}`;
  return `${c.least!.title} ${p.least}; ${W.others}`;
}

/** The note for a question about directions on screen. */
export function directionsNote(e: Extract<Evaluation, { ok: true }>, room: Scene): string {
  // One direction: Phase 5's own sentence, measured on it.
  if (e.readings.length === 1) {
    const r = e.readings[0];
    const lead = W.one(r.ordinal!, r.title);
    return r.answer.ok ? lead + r.answer.text : lead + AGENT_MESSAGES.noAnswer(r.answer.reason);
  }
  const threshold = e.question.kind === "circulation-at-least";
  const values = [e.now, ...e.readings].map((r) => `${r.ordinal === null ? W.now : `${r.ordinal}. ${r.title}`}${threshold ? ":" : ""} ${valueText(r, threshold, true)}`);
  const comparison = comparisonText(e, room);
  return [`${W.each(e.label)} ${values.join("; ")}.`, comparison, e.scaleNote].filter(Boolean).join(" ");
}

/** The short line a card shows for one direction. */
export function cardLine(e: Extract<Evaluation, { ok: true }>, r: Reading): string {
  const threshold = e.question.kind === "circulation-at-least";
  return threshold ? `${e.label}: ${valueText(r, true, false)}` : `${e.label} ${valueText(r, false, false)}`;
}

/** What a check says in the note, once the cards show each direction's line. */
export function checkSummary(e: Extract<Evaluation, { ok: true }>, room: Scene): string {
  if (e.question.kind === "circulation-at-least") {
    const groups: [string, number[]][] = [];
    for (const r of e.readings) {
      const word = r.answer.ok ? W.verdict[r.verdict ?? "no"] : W.unmeasured;
      const group = groups.find(([w]) => w === word);
      if (group) group[1].push(r.ordinal!);
      else groups.push([word, [r.ordinal!]]);
    }
    return `${e.label}: ${groups.map(([word, ordinals]) => `${word} for ${and(ordinals.map(String))}`).join("; ")}.`;
  }
  const comparison = comparisonText(e, room);
  if (comparison) return comparison;
  const only = e.readings[0];
  return only ? `${e.label}: ${valueText(only, false, true)}.` : "";
}

const and = (words: readonly string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0]);

// ---------------------------------------------------------------------------
// Checks on a design's new directions

export interface CheckedDirections {
  checks: readonly DirectionCheck[];
  /** One note for all of them: each check's comparison or verdicts, and any that could not be run. */
  note: string;
}

/**
 * Every check, measured on every direction. The proposals are read, never
 * changed; the checks are returned beside them for the session to carry.
 */
export function checkDirections(
  proposals: readonly DesignProposal[],
  questions: readonly DirectionQuestion[],
  context: Omit<EvaluationInput, "question" | "directions">,
): CheckedDirections {
  const directions = proposals.map((proposal, i) => ({ ordinal: i + 1, proposal }));
  const checks: DirectionCheck[] = [];
  const parts: string[] = [];
  let scaleNote = "";
  for (const question of questions) {
    const e = evaluateDirections({ ...context, question, directions });
    if (!e.ok) {
      parts.push(e.result.kind === "clarify" ? W.notCheckedWhich(e.result.options.map((o) => o.label)) : W.notChecked(e.result.message));
      continue;
    }
    scaleNote = e.scaleNote;
    checks.push({
      label: e.label,
      measuredOn: context.room,
      results: e.readings.map((r) => ({ proposalId: r.proposalId!, text: cardLine(e, r), verdict: r.verdict })),
    });
    parts.push(checkSummary(e, context.room));
  }
  return { checks, note: [W.checked, ...parts, scaleNote].filter(Boolean).join(" ") };
}
