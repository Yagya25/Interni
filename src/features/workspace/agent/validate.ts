import { MAX_VARIANTS, validateDesignIntent } from "../design/intent";
import { LAYOUT_AXES } from "../design/layout/intent";
import { FINISH_AXES } from "./schema";
import {
  AGENT_REPLY_VERSION,
  AGENT_REPLY_VERSION_0_1,
  CLARIFY_REASONS,
  DIRECTION_KINDS,
  LIMITS,
  MAX_CHECKS,
  OUT_OF_SCOPE_REASONS,
  QUESTION_KINDS,
  ROUTES,
  type AgentReply,
  type DirectionQuestion,
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
 *
 * Two versions: 0.2 (Phase 9, what the model is asked for) carries
 * `directions` and `checks`; 0.1 (Phase 6) is held to exactly its own key
 * set and rules, so a 0.1 reply reads as it always did.
 */

export type ReplyCheck = { ok: true; reply: AgentReply } | { ok: false; reason: string };

export function validateAgentReply(value: unknown, requestText: string): ReplyCheck {
  try {
    return { ok: true, reply: replyOf(value, requestText) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const REPLY_KEYS_0_1 = ["version", "route", "design", "question", "clarify", "outOfScope"] as const;
const REPLY_KEYS = ["version", "route", "design", "checks", "question", "directions", "clarify", "outOfScope"] as const;
const DESIGN_KEYS = ["version", "styles", "atmosphere", ...FINISH_AXES, "variantCount", "finishes", "layout"] as const;
const LAYOUT_KEYS = ["styles", ...LAYOUT_AXES, "preserve"] as const;
const QUESTION_KEYS = ["kind", "subject", "other", "metres"] as const;

function replyOf(value: unknown, text: string): AgentReply {
  const current = typeof value === "object" && value !== null && (value as { version?: unknown }).version === AGENT_REPLY_VERSION;
  const v = exact(value, current ? REPLY_KEYS : REPLY_KEYS_0_1, "reply") as Record<(typeof REPLY_KEYS)[number], unknown>;
  if (!current && v.version !== AGENT_REPLY_VERSION_0_1) throw new Error(`version must be ${AGENT_REPLY_VERSION}`);
  const route = oneOf(v.route, ROUTES, "route");
  // Exactly the payload the route names, and no other.
  const payloads = { design: v.design, question: v.question, clarify: v.clarify, outOfScope: v.outOfScope } as const;
  const own = route === "design" ? "design" : route === "question" ? "question" : route === "clarify" ? "clarify" : route === "out_of_scope" ? "outOfScope" : null;
  for (const [key, payload] of Object.entries(payloads)) {
    if (key !== own && payload !== null) throw new Error(`${key} must be null when the route is ${route}`);
    if (key === own && payload === null) throw new Error(`${key} is required when the route is ${route}`);
  }
  // 0.2's additions ride only with the route they belong to; null means none.
  const checks = current ? v.checks : null;
  const directions = current ? v.directions : null;
  if (checks !== null && route !== "design") throw new Error(`checks must be null when the route is ${route}`);
  if (directions !== null && route !== "question") throw new Error(`directions must be null when the route is ${route}`);
  switch (route) {
    case "design": {
      const design = designOf(v.design);
      return checks === null ? { route, design } : { route, design, checks: checksOf(checks, text) };
    }
    case "question": {
      if (directions === null) return { route, question: questionOf(v.question, text) };
      // A direction never changes a size: only what it can change is asked of it.
      const question = questionOf(v.question, text, "question", DIRECTION_KINDS, " when it asks about directions") as DirectionQuestion;
      return { route, question, directions: directionsOf(directions) };
    }
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

function questionOf(value: unknown, text: string, at = "question", kinds: readonly QuestionKind[] = QUESTION_KINDS, where = ""): QuestionWire {
  const q = exact(value, QUESTION_KEYS, at);
  const kind = oneOf(q.kind, kinds, `${at}.kind`, where);
  const needs = NEEDS[kind];
  for (const field of ["subject", "other"] as const) {
    if (needs[field] && q[field] === null) throw new Error(`${at}.${field} is required for ${kind}`);
    if (!needs[field] && q[field] !== null) throw new Error(`${at}.${field} must be null for ${kind}`);
    if (q[field] !== null) phrase(q[field], `${at}.${field}`, LIMITS.phrase);
  }
  if (!needs.metres && q.metres !== null) throw new Error(`${at}.metres must be null for ${kind}`);
  if (needs.metres) {
    if (typeof q.metres !== "number" || !Number.isFinite(q.metres)) throw new Error(`${at}.metres must be a finite number`);
    if (q.metres <= 0 || q.metres > LIMITS.metres) throw new Error(`${at}.metres must be above 0 and at most ${LIMITS.metres}`);
    // The model may only pass on a threshold the person stated.
    if (!statedLengths(text).some((m) => Math.abs(m - (q.metres as number)) < 1e-6)) {
      throw new Error(`${at}.metres must be a length stated in the request`);
    }
  }
  return { kind, subject: q.subject as string | null, other: q.other as string | null, metres: q.metres as number | null };
}

/** What to measure on each new direction: one to three questions of a kind a direction can change, none repeated. */
function checksOf(value: unknown, text: string): DirectionQuestion[] {
  if (!Array.isArray(value)) throw new Error("checks must be a list, or null");
  if (value.length === 0) throw new Error("checks must be null when there are none");
  if (value.length > MAX_CHECKS) throw new Error(`checks must hold at most ${MAX_CHECKS}`);
  const out = value.map((check, i) => questionOf(check, text, `checks[${i}]`, DIRECTION_KINDS) as DirectionQuestion);
  if (new Set(out.map((q) => JSON.stringify(q))).size !== out.length) throw new Error("checks must not repeat");
  return out;
}

/** Directions on screen, by their 1-based numbers: whole, in range, none repeated. Whether each is on screen is the workspace's to say. */
function directionsOf(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("directions must be a non-empty list of numbers, or null");
  value.forEach((n, i) => {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_VARIANTS) throw new Error(`directions[${i}] must be a whole number from 1 to ${MAX_VARIANTS}`);
  });
  if (new Set(value).size !== value.length) throw new Error("directions must not repeat");
  return value as number[];
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

function oneOf<T extends string>(v: unknown, options: readonly T[], at: string, where = ""): T {
  if (typeof v !== "string" || !options.includes(v as T)) throw new Error(`${at} must be one of ${options.join(", ")}${where}`);
  return v as T;
}

/** A short piece of plain words: no control characters, links or markup. */
function phrase(v: unknown, at: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${at} must be a non-empty string`);
  if (v.length > max) throw new Error(`${at} must be at most ${max} characters`);
  if (/[\u0000-\u001f\u007f<>{}`]|https?:|www\./i.test(v)) throw new Error(`${at} must be plain words`);
  return v;
}
