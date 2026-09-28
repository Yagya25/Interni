/**
 * The design agent's server configuration, from server-only environment
 * variables (never NEXT_PUBLIC_, so nothing reaches the browser bundle).
 * Unset, the agent is off: the route answers 404 and the workspace behaves
 * exactly as it did before Phase 6.
 *
 * DATUM_DESIGN_AGENT            "anthropic" or "groq" turns it on; anything else is off
 * ANTHROPIC_API_KEY             read by the Anthropic SDK itself
 * GROQ_API_KEY                  required for "groq"; without it the agent stays off
 * DATUM_DESIGN_AGENT_MODEL      default claude-opus-5 (anthropic), openai/gpt-oss-120b (groq)
 * DATUM_DESIGN_AGENT_EFFORT     low | medium | high | xhigh | max, default low
 * DATUM_DESIGN_AGENT_TIMEOUT_MS default 30000
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type Provider = "anthropic" | "groq";

export interface AgentConfig {
  provider: Provider;
  model: string;
  effort: Effort;
  timeoutMs: number;
}

export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

export function agentConfig(env: Readonly<Record<string, string | undefined>> = process.env): AgentConfig | null {
  const provider = env.DATUM_DESIGN_AGENT?.trim();
  if (provider !== "anthropic" && provider !== "groq") return null;
  // Groq has no other credential source: without the key the agent is simply off.
  if (provider === "groq" && !env.GROQ_API_KEY?.trim()) return null;
  const effort = (env.DATUM_DESIGN_AGENT_EFFORT?.trim() || "low") as Effort;
  const timeout = Number(env.DATUM_DESIGN_AGENT_TIMEOUT_MS?.trim() || 30_000);
  return {
    provider,
    model: env.DATUM_DESIGN_AGENT_MODEL?.trim() || (provider === "groq" ? DEFAULT_GROQ_MODEL : DEFAULT_MODEL),
    effort: EFFORTS.includes(effort) ? effort : "low",
    timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : 30_000,
  };
}
