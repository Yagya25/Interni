import { normalise, readBrief, readDesignRequest, type DesignRequest } from "../design/read";

/**
 * Where a request goes when the design agent is on.
 * ================================================================
 *
 * Deterministic, and used only in agent mode: with the agent off the
 * workspace routes exactly as it did before Phase 6.
 *
 * 1. An act on the directions on screen — but only when the words point at
 *    one: an ordinal, or a word such as "design", "layout" or "preview". A
 *    bare "it" is not enough ("…but keep it bright" is not an apply).
 * 2. A question ("how…", "is there…", "…?") goes to the agent, before the
 *    layout vocabulary can mistake "circulation space" for a layout request.
 * 3. A design brief the rules recognise goes to the agent, with the rules'
 *    reading as the fallback.
 * 4. Anything else is tried as a Phase 3E command first, unchanged; only
 *    words the command rules cannot read reach the agent.
 */

export type PreRoute =
  | { to: "session"; request: Extract<DesignRequest, { kind: "session" }> }
  | { to: "agent"; rulesBrief: boolean; question: boolean }
  | { to: "command" };

const POINTS_AT = /\b(designs?|layouts?|arrangements?|options?|versions?|variants?|directions?|schemes?|ideas?|concepts?|previews?)\b/;
const QUESTION = /^(how|what|whats|which|where|why|is|are|does|do|can|could|will|would|should|am|has|have)\b/;

export const isQuestion = (text: string) => text.trim().endsWith("?") || QUESTION.test(normalise(text));

export function preRoute(text: string): PreRoute {
  const words = normalise(text);
  const request = readDesignRequest(text);
  const question = isQuestion(text);
  if (request?.kind === "session" && !question && (request.ordinal !== null || POINTS_AT.test(words))) {
    return { to: "session", request };
  }
  const rulesBrief = request?.kind === "brief" || readBrief(text) !== null;
  if (question || rulesBrief) return { to: "agent", rulesBrief, question };
  return { to: "command" };
}
