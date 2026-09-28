import type { SceneEvidence } from "@/scene/compile/evidence";
import type { Id, Scene } from "@/scene/model/types";
import type { ClarifyOption } from "../ai/interpreter";
import { entityOf, normalise } from "../ai/rules/read";
import { describeAmong, resolveEntity } from "../ai/rules/resolve";
import { answer, type SpatialAnswer, type SpatialQuestion } from "../measure";
import { AGENT_MESSAGES } from "./messages";
import { AGENT_REPLY_VERSION, type QuestionWire } from "./types";
import { statedLengths, validateAgentReply } from "./validate";

/**
 * A question in words, answered by the deterministic engine.
 * ================================================================
 *
 * The model names pieces as a person would — "the sofa", "armchair 2",
 * "the glazed door". Those words are read by the Phase 3E entity reader and
 * resolved against the Scene by the Phase 3E resolver, with the same
 * clarification when a name fits several pieces. The answer — every number
 * and verdict in it — is Phase 5's `answer()`. Nothing here writes to the
 * Scene.
 */

export type QuestionResult =
  | { kind: "answer"; answer: Extract<SpatialAnswer, { ok: true }> }
  | { kind: "clarify"; message: string; options: readonly ClarifyOption[] }
  | { kind: "none"; message: string };

type Named = { ok: true; id: Id } | { ok: false; result: QuestionResult };

function named(scene: Scene, words: string, selectionId: Id | null, openings: boolean): Named {
  const resolved = resolveEntity(scene, entityOf(normalise(words)), selectionId, { roomFallback: false });
  switch (resolved.kind) {
    case "objects":
      if (resolved.objects.length === 1) return { ok: true, id: resolved.objects[0].id };
      return { ok: false, result: { kind: "clarify", message: AGENT_MESSAGES.whichOne(words), options: describeAmong(scene, resolved.objects) } };
    case "openings":
      if (openings && resolved.openings.length === 1) return { ok: true, id: resolved.openings[0].id };
      return { ok: false, result: { kind: "none", message: AGENT_MESSAGES.cannotMeasure(words) } };
    case "clarify":
      return {
        ok: false,
        result: resolved.clarification.reason === "ambiguous" ? { kind: "clarify", message: resolved.message, options: resolved.clarification.options } : { kind: "none", message: resolved.message },
      };
    case "missing":
      return { ok: false, result: { kind: "none", message: resolved.message } };
    default:
      return { ok: false, result: { kind: "none", message: AGENT_MESSAGES.cannotMeasure(words) } };
  }
}

const THRESHOLD = /\bat least\b/;
const CIRCULATION = /\b(circulation|walk|walking|walkway|walkways|passage|path|paths|way|ways|route|routes|room to (walk|move|pass|get through))\b/;

/**
 * The one question the rules can read without the model: "is there at
 * least 80 cm of circulation space?". Used only when the agent fails, so a
 * threshold is not re-read as a design count. The reply is built from the
 * person's own words — exactly one stated length — and held to the same
 * `validateAgentReply` as a model's; anything else is null.
 */
export function readThresholdQuestion(text: string): QuestionWire | null {
  const words = normalise(text);
  if (!THRESHOLD.test(words) || !CIRCULATION.test(words)) return null;
  const lengths = statedLengths(text);
  if (lengths.length !== 1) return null;
  const reply = {
    version: AGENT_REPLY_VERSION,
    route: "question",
    design: null,
    question: { kind: "circulation-at-least", subject: null, other: null, metres: lengths[0] },
    clarify: null,
    outOfScope: null,
  };
  const checked = validateAgentReply(reply, text);
  return checked.ok && checked.reply.route === "question" ? checked.reply.question : null;
}

export function resolveQuestion(wire: QuestionWire, scene: Scene, evidence: SceneEvidence | null, selectionId: Id | null): QuestionResult {
  let question: SpatialQuestion;
  const piece = (words: string | null, openings = false) => named(scene, words ?? "", selectionId, openings);
  switch (wire.kind) {
    case "room-size":
    case "free-floor":
    case "circulation-area":
      question = { kind: wire.kind };
      break;
    case "circulation-at-least":
      question = { kind: wire.kind, metres: wire.metres! };
      break;
    case "object-size":
    case "clearance":
    case "walkway": {
      const one = piece(wire.subject);
      if (!one.ok) return one.result;
      question = { kind: wire.kind, objectId: one.id };
      break;
    }
    case "distance": {
      const from = piece(wire.subject, true);
      if (!from.ok) return from.result;
      const to = piece(wire.other, true);
      if (!to.ok) return to.result;
      question = { kind: "distance", from: from.id, to: to.id };
      break;
    }
  }
  const result = answer(scene, evidence, question);
  return result.ok ? { kind: "answer", answer: result } : { kind: "none", message: AGENT_MESSAGES.noAnswer(result.reason) };
}
