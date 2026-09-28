import { FAILURES, type AgentFailure, type AgentResult, type DesignAgent } from "./types";
import { validateAgentReply } from "./validate";

/**
 * The design agent as the browser sees it: a POST to the server route. The
 * server's check is the authority; the reply is checked again here because
 * nothing that crosses the network is trusted.
 */

export const AGENT_ENDPOINT = "/api/agent/design";

export async function agentStatus(fetchImpl: typeof fetch = fetch): Promise<{ available: boolean; model: string | null }> {
  try {
    const res = await fetchImpl(AGENT_ENDPOINT, { method: "GET", cache: "no-store" });
    if (!res.ok) return { available: false, model: null };
    const body = (await res.json()) as { available?: unknown; model?: unknown };
    return body.available === true && typeof body.model === "string" ? { available: true, model: body.model } : { available: false, model: null };
  } catch {
    return { available: false, model: null };
  }
}

export function httpAgent(model: string, fetchImpl: typeof fetch = fetch): DesignAgent {
  return {
    kind: "model",
    name: `Claude (${model})`,
    async read(input, signal): Promise<AgentResult> {
      let res: Response;
      try {
        res = await fetchImpl(AGENT_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: input.text, brief: input.brief }),
          signal,
        });
      } catch {
        return { ok: false, failure: signal.aborted ? "cancelled" : "unavailable" };
      }
      if (res.status === 429) return { ok: false, failure: "rate-limited" };
      if (!res.ok) return { ok: false, failure: "unavailable" };
      let body: { ok?: unknown; reply?: unknown; failure?: unknown };
      try {
        body = await res.json();
      } catch {
        return { ok: false, failure: signal.aborted ? "cancelled" : "invalid" };
      }
      if (body.ok !== true) {
        const failure = FAILURES.includes(body.failure as AgentFailure) ? (body.failure as AgentFailure) : "unavailable";
        return { ok: false, failure };
      }
      const checked = validateAgentReply(body.reply, input.text);
      return checked.ok ? { ok: true, reply: checked.reply } : { ok: false, failure: "invalid" };
    },
  };
}
