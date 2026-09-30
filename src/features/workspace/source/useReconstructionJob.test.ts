import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hook's module imports the router; the follower under test never uses it.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {} }) }));

import type { JobView } from "../reconstruction/jobs/types";
import { createJobFollower, type JobState } from "./useReconstructionJob";

const A = "20260929T120000Z-aaaaaaaa-00000001";
const B = "20260929T120100Z-bbbbbbbb-00000002";

type Call = {
  url: string;
  init?: RequestInit;
  settled: boolean;
  resolve: (status: number, body: unknown) => void;
  reject: (error?: unknown) => void;
};

/**
 * A follower wired to a fetch that answers only when told to. With
 * `abortRejects`, an aborted request fails at once, as a browser's does;
 * without it, the response still arrives after the abort, which is the race
 * a generation check exists for.
 */
function harness({ recall = null as string | null, abortRejects = false } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const call: Call = {
        url,
        init,
        settled: false,
        resolve: (status, body) => {
          call.settled = true;
          resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
        },
        reject: (error = new TypeError("Failed to fetch")) => {
          call.settled = true;
          reject(error);
        },
      };
      calls.push(call);
      if (abortRejects) init?.signal?.addEventListener("abort", () => call.reject(new DOMException("aborted", "AbortError")));
    }),
  );
  const states: JobState[] = [];
  const opened: string[] = [];
  const remembered: (string | null)[] = [];
  let stored = recall;
  const follower = createJobFollower({
    fetch,
    setState: (s) => states.push(s),
    setSent: () => {},
    open: (runId) => opened.push(runId),
    remember: (runId) => {
      remembered.push(runId);
      stored = runId;
    },
    recall: () => stored,
  });
  const polls = (runId: string) => calls.filter((c) => c.url.endsWith(`/jobs/${runId}`));
  const last = (runId: string) => polls(runId).at(-1)!;
  const post = () => calls.filter((c) => c.init?.method === "POST").at(-1)!;
  /** Requests still able to change anything: not answered and not aborted. */
  const live = () => calls.filter((c) => !c.settled && !c.init?.signal?.aborted);
  return { follower, calls, states, opened, remembered, stored: () => stored, polls, last, post, live };
}

const view = (runId: string, status: JobView["status"], extra: Partial<JobView> = {}): JobView => ({
  runId,
  status,
  position: status === "queued" ? 1 : null,
  code: null,
  openable: status === "complete" || status === "degraded",
  elapsedMs: status === "running" ? 1000 : null,
  ...extra,
});

/** Let every pending promise continuation run (the follower awaits the response, then its body). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" });

/** Send a photograph and let the server accept it as `runId`. */
async function sent(h: ReturnType<typeof harness>, runId: string) {
  const sending = h.follower.start(photo(), `${runId}.jpg`);
  h.post().resolve(202, view(runId, "queued"));
  await sending;
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("following a job: queued → running → complete, degraded or failed", () => {
  it("sends the photograph, follows the job and opens the finished run", async () => {
    const h = harness();
    await sent(h, A);
    expect(h.post().init?.body).toBeInstanceOf(FormData);
    expect((h.post().init?.body as FormData).get("photo")).toBeInstanceOf(Blob);
    expect(h.states.slice(0, 2)).toEqual([{ phase: "sending" }, { phase: "queued", runId: A, position: 1, elapsedMs: null }]);
    expect(h.stored()).toBe(A);

    h.last(A).resolve(200, view(A, "queued"));
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    h.last(A).resolve(200, view(A, "running"));
    await settle();
    expect(h.states.at(-1)).toEqual({ phase: "running", runId: A, position: null, elapsedMs: 1000 });

    await vi.advanceTimersByTimeAsync(1500);
    h.last(A).resolve(200, view(A, "complete"));
    await settle();
    expect(h.states.at(-1)).toEqual({ phase: "opening", runId: A });
    expect(h.opened).toEqual([A]);
    expect(h.stored()).toBeNull();

    // Finished: nothing more is asked.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.polls(A)).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens a degraded run as well", async () => {
    const h = harness();
    await sent(h, A);
    h.last(A).resolve(200, view(A, "degraded"));
    await settle();
    expect(h.opened).toEqual([A]);
  });

  it("stops on a failed run with the worker's code, and opens nothing", async () => {
    const h = harness();
    await sent(h, A);
    h.last(A).resolve(200, view(A, "failed", { code: "no-floor" }));
    await settle();
    expect(h.states.at(-1)).toEqual({ phase: "failed", code: "no-floor" });
    expect(h.opened).toEqual([]);
    expect(h.stored()).toBeNull();
  });

  it("reports a job the server doesn't know as not-found", async () => {
    const h = harness();
    await sent(h, A);
    h.last(A).resolve(404, { code: "not-found" });
    await settle();
    expect(h.states.at(-1)).toEqual({ phase: "failed", code: "not-found" });
  });

  it("reports a refused upload's code and follows nothing", async () => {
    const h = harness();
    const sending = h.follower.start(photo(), "a.pdf");
    h.post().resolve(415, { code: "wrong-type" });
    await sending;
    expect(h.states.at(-1)).toEqual({ phase: "failed", code: "wrong-type" });
    expect(h.calls).toHaveLength(1);
    expect(h.remembered).toEqual([]);
  });

  it("reports an unreachable server when the upload itself fails", async () => {
    const h = harness();
    const sending = h.follower.start(photo(), "a.jpg");
    h.post().reject();
    await sending;
    expect(h.states.at(-1)).toEqual({ phase: "failed", code: "unreachable" });
  });

  it("keeps asking, every 3 s, while the server can't be reached", async () => {
    const h = harness();
    await sent(h, A);
    h.last(A).reject();
    await settle();
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.polls(A)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.polls(A)).toHaveLength(2);
  });

  it("asks every 1.5 s, then every 3 s once the job has taken a minute", async () => {
    const h = harness();
    const started = Date.now();
    await sent(h, A);
    const gaps: number[] = [];
    while (Date.now() - started < 65_000) {
      const count = h.polls(A).length;
      h.last(A).resolve(200, view(A, "running"));
      await settle();
      const from = Date.now();
      while (h.polls(A).length === count) await vi.advanceTimersByTimeAsync(100);
      gaps.push(Date.now() - from);
    }
    expect(gaps[0]).toBe(1500);
    expect(gaps.at(-1)).toBe(3000);
  });
});

describe.each([
  ["the response lands anyway after the abort", false],
  ["the abort cancels the request", true],
])("stale polls, when %s", (_, abortRejects) => {
  // a.
  it("reset while a status request is in flight aborts it and schedules nothing", async () => {
    const h = harness({ abortRejects });
    h.follower.follow(A);
    const inFlight = h.last(A);
    h.follower.reset();
    expect(inFlight.init?.signal?.aborted).toBe(true);
    expect(h.states.at(-1)).toEqual({ phase: "idle" });

    inFlight.resolve(200, view(A, "running"));
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
    expect(h.polls(A)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // b.
  it("a new job while the old status request is in flight aborts the old one and follows only the new", async () => {
    const h = harness({ abortRejects });
    h.follower.follow(A);
    const old = h.last(A);
    const sending = h.follower.start(photo(), "b.jpg");
    expect(old.init?.signal?.aborted).toBe(true);
    h.post().resolve(202, view(B, "queued"));
    await sending;
    await settle();

    old.resolve(200, view(A, "running"));
    await settle();
    expect(h.states.at(-1)).toEqual({ phase: "queued", runId: B, position: 1, elapsedMs: null });
    expect(h.polls(B)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.polls(A)).toHaveLength(1);
  });

  // c.
  it.each([
    ["still running", (c: Call) => c.resolve(200, view(A, "running"))],
    ["complete", (c: Call) => c.resolve(200, view(A, "complete"))],
    ["degraded", (c: Call) => c.resolve(200, view(A, "degraded"))],
    ["failed", (c: Call) => c.resolve(200, view(A, "failed", { code: "no-floor" }))],
    ["not found", (c: Call) => c.resolve(404, { code: "not-found" })],
    ["a network error", (c: Call) => c.reject()],
  ])("an old request resolving after reset as %s changes nothing", async (_, answer) => {
    const h = harness({ abortRejects });
    await sent(h, A);
    const inFlight = h.last(A);
    h.follower.reset();
    const before = { states: h.states.length, remembered: h.remembered.length };

    answer(inFlight);
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.states).toHaveLength(before.states);
    expect(h.remembered).toHaveLength(before.remembered);
    expect(h.opened).toEqual([]);
    expect(h.polls(A)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // d.
  it.each([
    ["still running", (c: Call) => c.resolve(200, view(A, "running"))],
    ["complete", (c: Call) => c.resolve(200, view(A, "complete"))],
    ["failed", (c: Call) => c.resolve(200, view(A, "failed", { code: "no-floor" }))],
    ["a network error", (c: Call) => c.reject()],
  ])("an old request resolving as %s after a new job starts changes nothing", async (_, answer) => {
    const h = harness({ abortRejects });
    await sent(h, A);
    const old = h.last(A);
    await sent(h, B);
    const before = h.states.length;

    answer(old);
    await settle();
    expect(h.states).toHaveLength(before);
    expect(h.stored()).toBe(B);
    expect(h.opened).toEqual([]);

    // The new job carries on, and is the only thing that can open a run.
    h.last(B).resolve(200, view(B, "running"));
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    h.last(B).resolve(200, view(B, "complete"));
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.opened).toEqual([B]);
    expect(h.polls(A)).toHaveLength(1);
  });

  // e.
  it("Strict Mode's mount, unmount and mount again leaves exactly one loop", async () => {
    const h = harness({ recall: A, abortRejects });
    h.follower.resume();
    h.follower.stop();
    h.follower.resume();
    const [first, second] = h.polls(A);
    expect(first.init?.signal?.aborted).toBe(true);
    expect(second.init?.signal?.aborted).toBe(false);

    first.resolve(200, view(A, "running"));
    second.resolve(200, view(A, "running"));
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.polls(A)).toHaveLength(3 + i);
      h.last(A).resolve(200, view(A, "running"));
      await settle();
      expect(vi.getTimerCount()).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(1500);
    h.last(A).resolve(200, view(A, "complete"));
    await settle();
    expect(h.opened).toEqual([A]);
  });

  // f.
  it("a pending run never has more than one live request or scheduled poll", async () => {
    const h = harness({ recall: A, abortRejects });
    h.follower.resume();
    h.follower.resume();
    h.follower.follow(A);
    expect(h.live()).toHaveLength(1);
    for (const c of h.polls(A)) c.resolve(200, view(A, "running"));
    await settle();
    for (let i = 0; i < 10; i++) {
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.live()).toHaveLength(1);
      h.last(A).resolve(200, view(A, "running"));
      await settle();
    }
    // Three starts, then one request per interval.
    expect(h.polls(A)).toHaveLength(3 + 10);
  });

  // g.
  it("a stale completion can never open the old run", async () => {
    const h = harness({ abortRejects });
    await sent(h, A);
    const inFlight = h.last(A);
    h.follower.reset(); // the photograph is replaced
    inFlight.resolve(200, view(A, "complete"));
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.opened).toEqual([]);

    // And a poll waiting on its timer, not yet sent, is never sent.
    const g = harness({ abortRejects });
    await sent(g, A);
    g.last(A).resolve(200, view(A, "running"));
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    g.follower.reset();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(g.polls(A)).toHaveLength(1);
    expect(g.opened).toEqual([]);

    // The next photograph's own run is the only one opened.
    await sent(g, B);
    g.last(B).resolve(200, view(B, "complete"));
    await settle();
    expect(g.opened).toEqual([B]);
  });

  // h.
  it("a stale failure cannot overwrite the new job's state", async () => {
    const h = harness({ abortRejects });
    await sent(h, A);
    const old = h.last(A);
    await sent(h, B);
    h.last(B).resolve(200, view(B, "running"));
    await settle();
    const now = h.states.at(-1);

    old.resolve(200, view(A, "failed", { code: "worker-crashed" }));
    await settle();
    expect(h.states.at(-1)).toEqual(now);
    expect(h.states.at(-1)).toMatchObject({ phase: "running", runId: B });
    expect(h.stored()).toBe(B);
  });

  it("an upload replaced while it is still being sent is never followed", async () => {
    const h = harness({ abortRejects });
    const sending = h.follower.start(photo(), "a.jpg");
    const upload = h.post();
    h.follower.reset();
    expect(upload.init?.signal?.aborted).toBe(true);
    upload.resolve(202, view(A, "queued"));
    await sending;
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
    expect(h.stored()).toBeNull();
    expect(h.polls(A)).toHaveLength(0);
  });
});

describe("reloading and leaving the page", () => {
  // i.
  it("a reload resumes the remembered job with exactly one poll", async () => {
    const h = harness({ recall: A });
    h.follower.resume();
    expect(h.calls).toHaveLength(1);
    h.last(A).resolve(200, view(A, "running"));
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.calls).toHaveLength(2);
    h.last(A).resolve(200, view(A, "complete"));
    await settle();
    expect(h.opened).toEqual([A]);
    expect(h.stored()).toBeNull();
  });

  it("with nothing remembered, resuming asks for nothing", () => {
    const h = harness();
    h.follower.resume();
    expect(h.calls).toHaveLength(0);
  });

  it("leaving the page stops following but keeps the job for the next visit", async () => {
    const h = harness({ recall: A });
    h.follower.resume();
    const inFlight = h.last(A);
    h.follower.stop();
    inFlight.resolve(200, view(A, "complete"));
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.states).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.stored()).toBe(A);
  });
});
