import { DESIGN_INTENT_VERSION } from "../design/intent";
import { LAYOUT_AXES, LAYOUT_STYLES } from "../design/layout/intent";
import { STYLE_ORDER } from "../design/styles";
import { AGENT_REPLY_VERSION, CLARIFY_REASONS, OUT_OF_SCOPE_REASONS, QUESTION_KINDS, ROUTES } from "./types";

/**
 * The structured-output schema the model answers in.
 * ================================================================
 *
 * Every enum is the code's own constant, so the schema cannot drift from
 * the validators. It holds no field for an id, an operation, a position, an
 * angle, a colour or a material. Numeric ranges and string lengths cannot be
 * said in this schema language; `validateAgentReply` enforces them.
 */

export const FINISH_AXES = ["warmth", "brightness", "contrast", "luxury", "minimalism", "coziness"] as const;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const LAYOUT = object({
  styles: { type: "array", items: { type: "string", enum: [...LAYOUT_STYLES] } },
  ...Object.fromEntries(LAYOUT_AXES.map((name) => [name, nullable({ type: "number" })])),
  preserve: { type: "boolean" },
});

const DESIGN = object({
  version: { type: "string", enum: [DESIGN_INTENT_VERSION] },
  styles: { type: "array", items: { type: "string", enum: [...STYLE_ORDER] } },
  atmosphere: nullable({ type: "string" }),
  ...Object.fromEntries(FINISH_AXES.map((name) => [name, nullable({ type: "number" })])),
  variantCount: { type: "integer" },
  finishes: { type: "boolean" },
  layout: nullable(LAYOUT),
});

const QUESTION = object({
  kind: { type: "string", enum: [...QUESTION_KINDS] },
  subject: nullable({ type: "string" }),
  other: nullable({ type: "string" }),
  metres: nullable({ type: "number" }),
});

export const AGENT_REPLY_SCHEMA = object({
  version: { type: "string", enum: [AGENT_REPLY_VERSION] },
  route: { type: "string", enum: [...ROUTES] },
  design: nullable(DESIGN),
  question: nullable(QUESTION),
  clarify: nullable({ type: "string", enum: [...CLARIFY_REASONS] }),
  outOfScope: nullable({ type: "string", enum: [...OUT_OF_SCOPE_REASONS] }),
});
