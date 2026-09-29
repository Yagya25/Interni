import type { DesignIntent } from "../design/intent";
import type { SpatialQuestion } from "../measure";

/**
 * The design agent's boundary.
 * ================================================================
 *
 *   words + room brief → language model → AgentReply (one closed schema)
 *        → validateAgentReply (server: authoritative; browser: again)
 *        → design: validateDesignIntent → fromIntent → the existing proposals
 *        → question: phrases resolved by the Phase 3E resolver → Phase 5 answer()
 *        → command: the person's own words → the Phase 3E rules
 *
 * The model reads words and nothing else. It has no field for an object
 * id, an operation, a coordinate, an angle, a colour or a material, and it
 * never sees an id: the brief names pieces by their labels. Every number
 * shown to the person comes from the deterministic engine.
 *
 * Phase 9 (0.2) adds two things, both still concepts: a question may name
 * the directions on screen it is about (`directions`, their numbers), and a
 * design may ask for up to three things to be measured on each new
 * direction (`checks`). The engine lays each direction over the room exactly
 * as Preview does and measures it with Phase 5; the model states no value.
 */

export const AGENT_REPLY_VERSION = "agent-reply-0.2";
/** Phase 6's version: still accepted exactly as it was, with neither directions nor checks. */
export const AGENT_REPLY_VERSION_0_1 = "agent-reply-0.1";

export const ROUTES = ["design", "question", "command", "clarify", "out_of_scope"] as const;
export type AgentRoute = (typeof ROUTES)[number];

export const QUESTION_KINDS = [
  "room-size",
  "object-size",
  "distance",
  "clearance",
  "free-floor",
  "circulation-area",
  "walkway",
  "circulation-at-least",
] as const satisfies readonly SpatialQuestion["kind"][];
export type QuestionKind = (typeof QUESTION_KINDS)[number];
// Every Phase 5 question kind is here, and nothing else.
type _AllKinds = Exclude<SpatialQuestion["kind"], QuestionKind> extends never ? true : never;
export const ALL_QUESTION_KINDS: _AllKinds = true;

export const CLARIFY_REASONS = ["design-or-layout", "which-room-part", "too-vague"] as const;
export type ClarifyReason = (typeof CLARIFY_REASONS)[number];

export const OUT_OF_SCOPE_REASONS = ["new-furniture", "image", "shopping", "not-about-the-room", "unsupported-question"] as const;
export type OutOfScopeReason = (typeof OUT_OF_SCOPE_REASONS)[number];

/** A spatial question as words: the kind, and pieces named by noun phrases, never by id. */
export interface QuestionWire {
  kind: QuestionKind;
  subject: string | null;
  other: string | null;
  /** A threshold, in metres, only when the person stated one. */
  metres: number | null;
}

/**
 * The question kinds a design direction can change the answer to, and so
 * the only ones measured on directions. A direction moves and refinishes
 * what the room has; it never changes a size.
 */
export const DIRECTION_KINDS = ["free-floor", "circulation-area", "walkway", "distance", "circulation-at-least"] as const satisfies readonly QuestionKind[];
export type DirectionKind = (typeof DIRECTION_KINDS)[number];
export type DirectionQuestion = QuestionWire & { kind: DirectionKind };
export const isDirectionQuestion = (q: QuestionWire): q is DirectionQuestion => (DIRECTION_KINDS as readonly string[]).includes(q.kind);

/** At most this many checks with one design request. */
export const MAX_CHECKS = 3;

/** A reply that has passed `validateAgentReply`. */
export type AgentReply =
  | { route: "design"; design: DesignIntent; checks?: readonly DirectionQuestion[] }
  | { route: "question"; question: QuestionWire; directions?: undefined }
  /** A question about directions on screen, by their 1-based numbers. */
  | { route: "question"; question: DirectionQuestion; directions: readonly number[] }
  | { route: "command" }
  | { route: "clarify"; clarify: ClarifyReason }
  | { route: "out_of_scope"; outOfScope: OutOfScopeReason };

export const FAILURES = ["unavailable", "timeout", "refused", "invalid", "rate-limited", "cancelled"] as const;
export type AgentFailure = (typeof FAILURES)[number];

export type AgentResult = { ok: true; reply: AgentReply } | { ok: false; failure: AgentFailure };

export interface AgentInput {
  text: string;
  /** The deterministic room brief (`brief.ts`): labels and honestly rounded measurements. */
  brief: string;
}

export interface DesignAgent {
  readonly kind: "model";
  readonly name: string;
  read(input: AgentInput, signal: AbortSignal): Promise<AgentResult>;
}

/** Limits on what reaches the model, and on what may come back. */
export const LIMITS = {
  text: 500,
  brief: 8000,
  body: 16_000,
  atmosphere: 80,
  phrase: 60,
  /** No stated threshold in a room is longer than this. */
  metres: 10,
} as const;
