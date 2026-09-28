import Anthropic from "@anthropic-ai/sdk";
import { briefMessage, repairMessage, requestMessage, SYSTEM_PROMPT } from "../prompt";
import { AGENT_REPLY_SCHEMA } from "../schema";
import type { AgentFailure, AgentInput } from "../types";
import { validateAgentReply } from "../validate";
import type { AgentConfig } from "./config";

/**
 * One request to Claude, and the authoritative check of its answer.
 * ================================================================
 *
 * A single structured-output call — no tools, nothing for the model to
 * invoke — with the frozen instructions and the room brief cached as a
 * prefix. The reply is checked by `validateAgentReply` here, on the server;
 * a reply that fails gets one repair turn with the validator's reason, and
 * then the request fails. Nothing is clamped or repaired in code.
 *
 * Returns the model's own JSON when it passes, so the browser can run the
 * very same check again.
 */

type Client = Pick<Anthropic, "beta">;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export type ClaudeResult = { ok: true; reply: unknown } | { ok: false; failure: AgentFailure; detail?: string };

/** Server-side refusal fallback: on a policy decline the API re-runs the request on a fallback model. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export async function readWithClaude(input: AgentInput, signal: AbortSignal, config: AgentConfig, client: Client): Promise<ClaudeResult> {
  const messages: Params["messages"] = [
    {
      role: "user",
      content: [
        { type: "text", text: briefMessage(input.brief), cache_control: { type: "ephemeral" } },
        { type: "text", text: requestMessage(input.text) },
      ],
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model: config.model,
          max_tokens: 16_000,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          output_config: { effort: config.effort, format: { type: "json_schema", schema: AGENT_REPLY_SCHEMA } },
          messages,
        },
        { signal, timeout: config.timeoutMs, maxRetries: 1 },
      );
    } catch (error) {
      return { ok: false, failure: failureOf(error, signal) };
    }
    if (response.stop_reason === "refusal") return { ok: false, failure: "refused" };
    if (response.stop_reason === "max_tokens") return { ok: false, failure: "invalid", detail: "the reply was cut off" };
    const text = response.content.find((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")?.text;
    let value: unknown = undefined;
    let reason: string;
    try {
      value = text === undefined ? undefined : JSON.parse(text);
      const checked = validateAgentReply(value, input.text);
      if (checked.ok) return { ok: true, reply: value };
      reason = checked.reason;
    } catch {
      reason = "the reply was not JSON";
    }
    if (attempt === 1) return { ok: false, failure: "invalid", detail: reason };
    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
    messages.push({ role: "user", content: repairMessage(reason) });
  }
  return { ok: false, failure: "invalid" };
}

function failureOf(error: unknown, signal: AbortSignal): AgentFailure {
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError) return "cancelled";
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.RateLimitError) return "rate-limited";
  return "unavailable";
}
