import Anthropic from "@anthropic-ai/sdk";
import { LIMITS, type AgentInput } from "../types";
import { readWithClaude, type ClaudeResult } from "./anthropic";
import { agentConfig, type AgentConfig } from "./config";
import { readWithGroq } from "./groq";

/**
 * The design agent's HTTP boundary, kept apart from the route file so it can
 * be tested with a fake client. POST only, same origin, size-limited and
 * rate-limited; off (404) unless the server is configured. The API key never
 * leaves the server: the SDK reads it from the environment.
 */

export interface HandlerDeps {
  config: AgentConfig | null;
  read: (input: AgentInput, signal: AbortSignal, config: AgentConfig) => Promise<ClaudeResult>;
  limiter: RateLimiter;
}

export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  take(): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(t);
    return true;
  }
}

let client: Anthropic | null = null;
const defaultDeps = (): HandlerDeps => ({
  config: agentConfig(),
  read: (input, signal, config) =>
    config.provider === "groq"
      ? readWithGroq(input, signal, config, process.env.GROQ_API_KEY?.trim() ?? "")
      : readWithClaude(input, signal, config, (client ??= new Anthropic())),
  limiter: sharedLimiter,
});
const sharedLimiter = new RateLimiter();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function handleStatus(deps: Pick<HandlerDeps, "config"> = defaultDeps()): Response {
  // Always 200: "off" is an answer, not an error, so the browser logs nothing.
  if (!deps.config) return json({ available: false });
  return json({ available: true, model: deps.config.model });
}

export async function handleRead(request: Request, deps: HandlerDeps = defaultDeps()): Promise<Response> {
  if (!deps.config) return json({ error: "not-configured" }, 404);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "cross-origin" }, 403);
  const raw = await request.text();
  if (raw.length > LIMITS.body) return json({ error: "too-large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad-request" }, 400);
  }
  const input = inputOf(body);
  if (!input) return json({ error: "bad-request" }, 400);
  if (!deps.limiter.take()) return json({ ok: false, failure: "rate-limited" }, 429);
  const result = await deps.read(input, request.signal, deps.config);
  if (!result.ok) console.warn(`[design agent] ${result.failure}${result.detail ? `: ${result.detail}` : ""}`);
  return json(result.ok ? { ok: true, reply: result.reply } : { ok: false, failure: result.failure });
}

function inputOf(body: unknown): AgentInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("text") || !keys.includes("brief")) return null;
  const { text, brief } = body as Record<string, unknown>;
  if (typeof text !== "string" || !text.trim() || text.length > LIMITS.text) return null;
  if (typeof brief !== "string" || brief.length > LIMITS.brief) return null;
  return { text, brief };
}
