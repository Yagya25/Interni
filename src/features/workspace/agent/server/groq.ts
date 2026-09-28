import { briefMessage, repairMessage, requestMessage, SYSTEM_PROMPT } from "../prompt";
import { AGENT_REPLY_SCHEMA } from "../schema";
import type { AgentInput } from "../types";
import { validateAgentReply } from "../validate";
import type { ClaudeResult as ProviderResult } from "./anthropic";
import type { AgentConfig } from "./config";

/**
 * One request to a model on Groq, through its OpenAI-compatible API, and
 * the authoritative check of its answer. The same contract as the Claude
 * adapter: one structured-output call (strict JSON Schema, no tools), the
 * reply checked by `validateAgentReply` here on the server, one repair turn
 * with the validator's reason, then failure. Nothing is repaired in code.
 *
 * The key is read from GROQ_API_KEY by the caller and sent only in the
 * Authorization header; it is never logged or returned.
 */

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

type Message = { role: "system" | "user" | "assistant"; content: string };

export interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export async function readWithGroq(
  input: AgentInput,
  signal: AbortSignal,
  config: AgentConfig,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  onUsage?: (usage: GroqUsage) => void,
): Promise<ProviderResult> {
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: briefMessage(input.brief) },
    { role: "user", content: requestMessage(input.text) },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const sent = await post(messages, signal, config, apiKey, fetchImpl);
    if (!sent.ok) return sent;
    const body = sent.body;
    if (body.usage) onUsage?.(body.usage);
    const choice = body.choices?.[0];
    if (choice?.message?.refusal) return { ok: false, failure: "refused" };
    if (choice?.finish_reason === "length") return { ok: false, failure: "invalid", detail: "the reply was cut off" };
    const text = choice?.message?.content;
    let reason: string;
    try {
      const value: unknown = typeof text === "string" ? JSON.parse(text) : undefined;
      const checked = validateAgentReply(value, input.text);
      if (checked.ok) return { ok: true, reply: value };
      reason = checked.reason;
    } catch {
      reason = "the reply was not JSON";
    }
    if (attempt === 1) return { ok: false, failure: "invalid", detail: reason };
    messages.push({ role: "assistant", content: typeof text === "string" ? text : "" });
    messages.push({ role: "user", content: repairMessage(reason) });
  }
  return { ok: false, failure: "invalid" };
}

interface GroqBody {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: GroqUsage;
}

/** One POST, retried once on 429 or 5xx; bounded by the configured timeout and the caller's signal. */
async function post(messages: Message[], signal: AbortSignal, config: AgentConfig, apiKey: string, fetchImpl: typeof fetch): Promise<{ ok: true; body: GroqBody } | Extract<ProviderResult, { ok: false }>> {
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const both = AbortSignal.any([signal, deadline]);
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(`${GROQ_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages,
          reasoning_effort: config.effort === "medium" || config.effort === "high" ? config.effort : "low",
          max_completion_tokens: 8000,
          response_format: { type: "json_schema", json_schema: { name: "agent_reply", strict: true, schema: AGENT_REPLY_SCHEMA } },
        }),
        signal: both,
      });
    } catch {
      if (signal.aborted) return { ok: false, failure: "cancelled" };
      if (deadline.aborted) return { ok: false, failure: "timeout" };
      if (attempt === 0) continue;
      return { ok: false, failure: "unavailable" };
    }
    if (res.ok) {
      try {
        return { ok: true, body: (await res.json()) as GroqBody };
      } catch {
        return { ok: false, failure: "invalid", detail: "the response was not JSON" };
      }
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) continue;
    if (res.status === 429) return { ok: false, failure: "rate-limited" };
    // A 400 here is usually the model failing strict schema generation: say so, without the body.
    return { ok: false, failure: res.status === 400 ? "invalid" : "unavailable", detail: `HTTP ${res.status}` };
  }
  return { ok: false, failure: "unavailable" };
}
