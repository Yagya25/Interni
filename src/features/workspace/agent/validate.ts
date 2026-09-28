import { validateDesignIntent } from "../design/intent";
import { LAYOUT_AXES } from "../design/layout/intent";
import { FINISH_AXES } from "./schema";
import {
  AGENT_REPLY_VERSION,
  CLARIFY_REASONS,
  LIMITS,
  OUT_OF_SCOPE_REASONS,
  QUESTION_KINDS,
  ROUTES,
  type AgentReply,
  type QuestionKind,
  type QuestionWire,
} from "./types";

/**
 * Whether a model's reply may be used at all.
 * ================================================================
 *
 * Pure, and the same on the server — where it is the authority — and in the
 * browser, where it runs again because the network is never trusted.
 * Stricter than `validateDesignIntent`, which rebuilds an intent and drops
 * keys it does not know: here an unknown key is a refusal, so a reply that
 * tries to carry an `objectId` or `operations` is rejected, not trimmed.
 * Nothing is clamped, coerced or repaired.
 */

export type ReplyCheck = { ok: true; reply: AgentReply } | { ok: false; reason: string };

export function validateAgentReply(value: unknown, requestText: string): ReplyCheck {
  try {
    return { ok: true, reply: replyOf(value, requestText) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const REPLY_KEYS = ["version", "route", "design", "question", "clarify", "outOfScope"] as const;
const DESIGN_KEYS = ["version", "styles", "atmosphere", ...FINISH_AXES, "variantCount", "finishes", "layout"] as const;
const LAYOUT_KEYS = ["styles", ...LAYOUT_AXES, "preserve"] as const;
const QUESTION_KEYS = ["kind", "subject", "other", "metres"] as const;

function replyOf(value: unknown, text: string): AgentReply {
  const v = exact(value, REPLY_KEYS, "reply");
  if (v.version !== AGENT_REPLY_VERSION) throw new Error(`version must be ${AGENT_REPLY_VERSION}`);
  const route = oneOf(v.route, ROUTES, "route");
  // Exactly the payload the route names, and no other.
  const payloads = { design: v.design, question: v.question, clarify: v.clarify, outOfScope: v.outOfScope } as const;
  const own = route === "design" ? "design" : route === "question" ? "question" : route === "clarify" ? "clarify" : route === "out_of_scope" ? "outOfScope" : null;
  for (const [key, payload] of Object.entries(payloads)) {
    if (key !== own && payload !== null) throw new Error(`${key} must be null when the route is ${route}`);
    if (key === own && payload === null) throw new Error(`${key} is required when the route is ${route}`);
  }
  switch (route) {
    case "design":
      return { route, design: designOf(v.design) };
    case "question":
      return { route, question: questionOf(v.question, text) };
    case "command":
      return { route };
    case "clarify":
      return { route, clarify: oneOf(v.clarify, CLARIFY_REASONS, "clarify") };
    case "out_of_scope":
      return { route, outOfScope: oneOf(v.outOfScope, OUT_OF_SCOPE_REASONS, "outOfScope") };
  }
}

function designOf(value: unknown) {
  const d = exact(value, DESIGN_KEYS, "design");
  if (d.layout !== null) exact(d.layout, LAYOUT_KEYS, "design.layout");
  if (d.atmosphere !== null) phrase(d.atmosphere, "design.atmosphere", LIMITS.atmosphere);
  // The frozen Phase 4A/4B rules, word for word.
  const checked = validateDesignIntent(d);
  if (!checked.ok) throw new Error(`design: ${checked.reason}`);
  return checked.intent;
}

/** What each question kind needs, and what it must leave empty. */
const NEEDS: Readonly<Record<QuestionKind, { subject: boolean; other: boolean; metres: boolean }>> = {
  "room-size": { subject: false, other: false, metres: false },
  "object-size": { subject: true, other: false, metres: false },
  distance: { subject: true, other: true, metres: false },
  clearance: { subject: true, other: false, metres: false },
  "free-floor": { subject: false, other: false, metres: false },
  "circulation-area": { subject: false, other: false, metres: false },
  walkway: { subject: true, other: false, metres: false },
  "circulation-at-least": { subject: false, other: false, metres: true },
};

function questionOf(value: unknown, text: string): QuestionWire {
  const q = exact(value, QUESTION_KEYS, "question");
  const kind = oneOf(q.kind, QUESTION_KINDS, "question.kind");
  const needs = NEEDS[kind];
  for (const field of ["subject", "other"] as const) {
    if (needs[field] && q[field] === null) throw new Error(`question.${field} is required for ${kind}`);
    if (!needs[field] && q[field] !== null) throw new Error(`question.${field} must be null for ${kind}`);
    if (q[field] !== null) phrase(q[field], `question.${field}`, LIMITS.phrase);
  }
  if (!needs.metres && q.metres !== null) throw new Error(`question.metres must be null for ${kind}`);
  if (needs.metres) {
    if (typeof q.metres !== "number" || !Number.isFinite(q.metres)) throw new Error("question.metres must be a finite number");
    if (q.metres <= 0 || q.metres > LIMITS.metres) throw new Error(`question.metres must be above 0 and at most ${LIMITS.metres}`);
    // The model may only pass on a threshold the person stated.
    if (!statedLengths(text).some((m) => Math.abs(m - (q.metres as number)) < 1e-6)) {
      throw new Error("question.metres must be a length stated in the request");
    }
  }
  return { kind, subject: q.subject as string | null, other: q.other as string | null, metres: q.metres as number | null };
}

const UNITS: readonly [RegExp, number][] = [
  [/^(mm|millimet(?:er|re)s?)$/, 0.001],
  [/^(cm|centimet(?:er|re)s?)$/, 0.01],
  [/^(m|met(?:er|re)s?)$/, 1],
  [/^(in|inch|inches)$/, 0.0254],
  [/^(ft|foot|feet)$/, 0.3048],
];

/** Every length written in the request, in metres: "80 cm", "0.8 m", "2 feet". */
export function statedLengths(text: string): number[] {
  const out: number[] = [];
  for (const match of text.toLowerCase().matchAll(/(\d+(?:[.,]\d+)?)\s*([a-z]+)/g)) {
    const unit = UNITS.find(([pattern]) => pattern.test(match[2]));
    if (unit) out.push(Number((Number(match[1].replace(",", ".")) * unit[1]).toFixed(6)));
  }
  return out;
}

// ---------------------------------------------------------------------------

function exact<K extends string>(value: unknown, keys: readonly K[], at: string): Record<K, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`);
  const own = Object.keys(value);
  const unknown = own.filter((key) => !(keys as readonly string[]).includes(key));
  if (unknown.length) throw new Error(`${at} has unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  const missing = keys.filter((key) => !own.includes(key));
  if (missing.length) throw new Error(`${at} is missing: ${missing.join(", ")}`);
  return value as Record<K, unknown>;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], at: string): T {
  if (typeof v !== "string" || !options.includes(v as T)) throw new Error(`${at} must be one of ${options.join(", ")}`);
  return v as T;
}

/** A short piece of plain words: no control characters, links or markup. */
function phrase(v: unknown, at: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${at} must be a non-empty string`);
  if (v.length > max) throw new Error(`${at} must be at most ${max} characters`);
  if (/[\u0000-\u001f\u007f<>{}`]|https?:|www\./i.test(v)) throw new Error(`${at} must be plain words`);
  return v;
}
