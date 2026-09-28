import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { readWithClaude } from "./server/anthropic";
import { AGENT_REPLY_SCHEMA } from "./schema";
import { agentConfig, type AgentConfig } from "./server/config";
import { readWithGroq } from "./server/groq";
import { handleRead, handleStatus, RateLimiter, type HandlerDeps } from "./server/handler";

const CONFIG: AgentConfig = { provider: "anthropic", model: "claude-opus-5", effort: "low", timeoutMs: 30_000 };
const INPUT = { text: "Make it feel calm and bright", brief: "Room: a test room." };

const valid = {
  version: "agent-reply-0.1",
  route: "design",
  design: {
    version: "design-intent-0.2",
    styles: ["SCANDINAVIAN"],
    atmosphere: "calm and bright",
    warmth: null,
    brightness: 0.65,
    contrast: null,
    luxury: null,
    minimalism: null,
    coziness: null,
    variantCount: 1,
    finishes: true,
    layout: null,
  },
  question: null,
  clarify: null,
  outOfScope: null,
};

const message = (text: string, stop_reason = "end_turn") => ({ content: [{ type: "text", text }], stop_reason });

/** A test double for the SDK: it records every request and answers from a script. Not a model. */
function fakeClient(...answers: (object | Error)[]) {
  const create = vi.fn(async (...call: [params: unknown, options: unknown]) => {
    void call;
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { beta: { messages: { create } } } as unknown as Pick<Anthropic, "beta">, create };
}

describe("the Claude adapter", () => {
  it("asks once, with structured output, low effort, the refusal fallback and a cached prefix — and no tools", async () => {
    const { client, create } = fakeClient(message(JSON.stringify(valid)));
    const signal = new AbortController().signal;
    const result = await readWithClaude(INPUT, signal, CONFIG, client);
    expect(result).toEqual({ ok: true, reply: valid });
    expect(create).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading back a recorded request
    const [params, options] = create.mock.calls[0] as [Record<string, any>, Record<string, unknown>];
    expect(params.model).toBe("claude-opus-5");
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.tools).toBeUndefined();
    expect(params.thinking).toBeUndefined();
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.messages[0].content[0]).toMatchObject({ text: "Room description:\nRoom: a test room.", cache_control: { type: "ephemeral" } });
    expect(params.messages[0].content[1]).toEqual({ type: "text", text: "Request: Make it feel calm and bright" });
    expect(options).toEqual({ signal, timeout: 30_000, maxRetries: 1 });
  });

  it("repairs once with the validator's reason, then gives up", async () => {
    const bad = { ...valid, design: { ...valid.design, warmth: 3 } };
    const once = fakeClient(message(JSON.stringify(bad)), message(JSON.stringify(valid)));
    expect(await readWithClaude(INPUT, new AbortController().signal, CONFIG, once.client)).toEqual({ ok: true, reply: valid });
    const second = once.create.mock.calls[1][0] as { messages: { role: string; content: unknown }[] };
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1].role).toBe("assistant");
    expect(second.messages[2]).toEqual({ role: "user", content: "That reply was rejected: design: warmth must be between -1 and 1. Reply again in the schema, following the rules." });

    const twice = fakeClient(message(JSON.stringify(bad)), message("not json"));
    expect(await readWithClaude(INPUT, new AbortController().signal, CONFIG, twice.client)).toEqual({ ok: false, failure: "invalid", detail: "the reply was not JSON" });
    expect(twice.create).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown fields from the model rather than trimming them", async () => {
    const sneaky = { ...valid, operations: [{ kind: "move", objectId: "sofa-0", to: [0, 0, 0] }] };
    const { client } = fakeClient(message(JSON.stringify(sneaky)), message(JSON.stringify(sneaky)));
    expect(await readWithClaude(INPUT, new AbortController().signal, CONFIG, client)).toMatchObject({ ok: false, failure: "invalid", detail: "reply has unknown field: operations" });
  });

  it("does not retry a refusal or a reply that was cut off", async () => {
    const refused = fakeClient(message("", "refusal"));
    expect(await readWithClaude(INPUT, new AbortController().signal, CONFIG, refused.client)).toEqual({ ok: false, failure: "refused" });
    expect(refused.create).toHaveBeenCalledTimes(1);
    const cut = fakeClient(message('{"version":', "max_tokens"));
    expect(await readWithClaude(INPUT, new AbortController().signal, CONFIG, cut.client)).toMatchObject({ ok: false, failure: "invalid" });
    expect(cut.create).toHaveBeenCalledTimes(1);
  });

  it("names each failure by the SDK's own error classes", async () => {
    const cases: [Error, string][] = [
      [new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()), "rate-limited"],
      [new Anthropic.APIConnectionTimeoutError(), "timeout"],
      [new Anthropic.APIUserAbortError(), "cancelled"],
      [new Anthropic.InternalServerError(500, undefined, "boom", new Headers()), "unavailable"],
      [new Error("socket hang up"), "unavailable"],
    ];
    for (const [error, failure] of cases) {
      const { client } = fakeClient(error);
      expect(await readWithClaude(INPUT, new AbortController().signal, CONFIG, client)).toEqual({ ok: false, failure });
    }
    const aborted = new AbortController();
    aborted.abort();
    expect(await readWithClaude(INPUT, aborted.signal, CONFIG, fakeClient(new Error("aborted")).client)).toEqual({ ok: false, failure: "cancelled" });
  });
});

describe("the configuration", () => {
  it("is off unless asked for, and defaults to Claude Opus 5 at low effort", () => {
    expect(agentConfig({})).toBeNull();
    expect(agentConfig({ DATUM_DESIGN_AGENT: "on" })).toBeNull();
    expect(agentConfig({ DATUM_DESIGN_AGENT: "anthropic" })).toEqual({ provider: "anthropic", model: "claude-opus-5", effort: "low", timeoutMs: 30_000 });
    expect(agentConfig({ DATUM_DESIGN_AGENT: "groq" })).toBeNull();
    expect(agentConfig({ DATUM_DESIGN_AGENT: "groq", GROQ_API_KEY: "k" })).toEqual({ provider: "groq", model: "openai/gpt-oss-120b", effort: "low", timeoutMs: 30_000 });
    expect(agentConfig({ DATUM_DESIGN_AGENT: "anthropic", DATUM_DESIGN_AGENT_EFFORT: "turbo", DATUM_DESIGN_AGENT_TIMEOUT_MS: "-4" })).toMatchObject({ effort: "low", timeoutMs: 30_000 });
  });
});

describe("the route", () => {
  const deps = (over: Partial<HandlerDeps> = {}): HandlerDeps => ({
    config: CONFIG,
    read: vi.fn(async () => ({ ok: true as const, reply: valid })),
    limiter: new RateLimiter(100),
    ...over,
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://localhost:3100/api/agent/design", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("is off — 404 to a read, and a plain 'not available' to a status check — unless configured", async () => {
    expect((await handleRead(post(INPUT), deps({ config: null }))).status).toBe(404);
    const status = handleStatus({ config: null });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ available: false });
    expect(await handleStatus({ config: CONFIG }).json()).toEqual({ available: true, model: "claude-opus-5" });
  });

  it("passes the model's validated JSON through, with the request's own signal", async () => {
    const d = deps();
    const request = post(INPUT, { origin: "http://localhost:3100" });
    const res = await handleRead(request, d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reply: valid });
    expect((d.read as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(INPUT);
    expect((d.read as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(request.signal);
  });

  it("reports a failure by name, never with detail or a key", async () => {
    const res = await handleRead(post(INPUT), deps({ read: async () => ({ ok: false, failure: "timeout", detail: "secret detail" }) }));
    expect(await res.json()).toEqual({ ok: false, failure: "timeout" });
  });

  it("refuses other origins, oversized or malformed bodies, and too many requests", async () => {
    expect((await handleRead(post(INPUT, { origin: "https://evil.example" }), deps())).status).toBe(403);
    expect((await handleRead(post({ text: "x", brief: "y".repeat(17_000) }), deps())).status).toBe(413);
    expect((await handleRead(post("{nope"), deps())).status).toBe(400);
    expect((await handleRead(post({ ...INPUT, model: "claude-fable-5-1" }), deps())).status).toBe(400);
    expect((await handleRead(post({ text: "x".repeat(501), brief: "" }), deps())).status).toBe(400);
    expect((await handleRead(post({ text: "  ", brief: "" }), deps())).status).toBe(400);
    const limited = deps({ limiter: new RateLimiter(1) });
    expect((await handleRead(post(INPUT), limited)).status).toBe(200);
    const second = await handleRead(post(INPUT), limited);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ ok: false, failure: "rate-limited" });
  });
});

describe("the Groq adapter", () => {
  const GROQ: AgentConfig = { provider: "groq", model: "openai/gpt-oss-120b", effort: "low", timeoutMs: 30_000 };
  const completion = (content: string | null, finish_reason = "stop", refusal: string | null = null) =>
    new Response(JSON.stringify({ choices: [{ finish_reason, message: { content, refusal } }], usage: { prompt_tokens: 1200, completion_tokens: 150 } }), { status: 200 });
  /** A test double for fetch: records each request and answers from a script. Not a model. */
  const fakeFetch = (...answers: (Response | Error)[]) =>
    vi.fn(async (_url: string, _init: RequestInit) => {
      void _url;
      void _init;
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      if (next instanceof Error) throw next;
      return next;
    });

  it("asks once, with strict JSON Schema, low reasoning effort and the key only in the header", async () => {
    const f = fakeFetch(completion(JSON.stringify(valid)));
    const usage = vi.fn();
    const result = await readWithGroq(INPUT, new AbortController().signal, GROQ, "test-key", f as unknown as typeof fetch, usage);
    expect(result).toEqual({ ok: true, reply: valid });
    expect(usage).toHaveBeenCalledWith({ prompt_tokens: 1200, completion_tokens: 150 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.reasoning_effort).toBe("low");
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "agent_reply", strict: true, schema: AGENT_REPLY_SCHEMA } });
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("test-key");
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "user"]);
    expect(body.messages[1].content).toBe("Room description:\nRoom: a test room.");
    expect(body.messages[2].content).toBe("Request: Make it feel calm and bright");
  });

  it("repairs once with the validator's reason, then gives up; never trims unknown fields", async () => {
    const bad = { ...valid, design: { ...valid.design, warmth: 3 } };
    const f = fakeFetch(completion(JSON.stringify(bad)), completion(JSON.stringify(valid)));
    expect(await readWithGroq(INPUT, new AbortController().signal, GROQ, "k", f as unknown as typeof fetch)).toEqual({ ok: true, reply: valid });
    const second = JSON.parse(f.mock.calls[1][1].body as string);
    expect(second.messages.slice(3)).toEqual([
      { role: "assistant", content: JSON.stringify(bad) },
      { role: "user", content: "That reply was rejected: design: warmth must be between -1 and 1. Reply again in the schema, following the rules." },
    ]);
    const sneaky = JSON.stringify({ ...valid, operations: [] });
    expect(await readWithGroq(INPUT, new AbortController().signal, GROQ, "k", fakeFetch(completion(sneaky), completion(sneaky)) as unknown as typeof fetch)).toMatchObject({
      ok: false,
      failure: "invalid",
      detail: "reply has unknown field: operations",
    });
  });

  it("handles refusal, truncation, schema errors, rate limits, server errors, timeouts and cancellation", async () => {
    const sig = () => new AbortController().signal;
    const run = (f: ReturnType<typeof fakeFetch>, config = GROQ, signal = sig()) => readWithGroq(INPUT, signal, config, "k", f as unknown as typeof fetch);
    expect(await run(fakeFetch(completion(null, "stop", "I can't help with that")))).toEqual({ ok: false, failure: "refused" });
    expect(await run(fakeFetch(completion('{"version":', "length")))).toMatchObject({ ok: false, failure: "invalid" });
    expect(await run(fakeFetch(new Response("{}", { status: 400 })))).toEqual({ ok: false, failure: "invalid", detail: "HTTP 400" });
    const limited = fakeFetch(new Response("{}", { status: 429 }), new Response("{}", { status: 429 }));
    expect(await run(limited)).toEqual({ ok: false, failure: "rate-limited" });
    expect(limited).toHaveBeenCalledTimes(2);
    const recovered = fakeFetch(new Response("{}", { status: 503 }), completion(JSON.stringify(valid)));
    expect(await run(recovered)).toEqual({ ok: true, reply: valid });
    expect(await run(fakeFetch(new Response("{}", { status: 401 })))).toEqual({ ok: false, failure: "unavailable", detail: "HTTP 401" });
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await readWithGroq(INPUT, sig(), { ...GROQ, timeoutMs: 50 }, "k", hang as unknown as typeof fetch)).toEqual({ ok: false, failure: "timeout" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(await readWithGroq(INPUT, controller.signal, GROQ, "k", hang as unknown as typeof fetch)).toEqual({ ok: false, failure: "cancelled" });
  });
});
