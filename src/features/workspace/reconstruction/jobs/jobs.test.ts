import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import { listRuns, RUN_ID } from "../localRuns";
import { enqueueUpload, jobStatus } from "./api";
import { jobConfig, parseWslPath, type JobConfig } from "./config";
import { processLauncher, workerArgs } from "./launcher";
import { outcome } from "./outcome";
import { JobQueue } from "./queue";
import { newRunId } from "./runId";
import { createJob, jobDir, readRecord } from "./store";
import type { JobRecord } from "./types";
import { sniffImage, validateUpload } from "./validate";

const FAKE_WORKER = fileURLToPath(new URL("../../../../../tests/fixtures/reconstruction/fake-worker.mjs", import.meta.url));

const JPEG = (n = 2048, fill = 7) => {
  const b = new Uint8Array(n).fill(fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = () => new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const JPEG_KIND = { type: "image/jpeg", ext: "jpg" } as const;

let dir: string;
const saved: Record<string, string | undefined> = {};
const setEnv = (key: string, value: string | undefined) => {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "datum-jobs-"));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const config = (over: Partial<JobConfig> = {}): JobConfig => ({
  runsDir: dir,
  launcher: { kind: "command", command: process.execPath, args: [FAKE_WORKER] },
  maxBytes: 24 * 1024 * 1024,
  maxQueued: 5,
  timeoutMs: 20_000,
  retainFailedDays: 7,
  retainOriginalsDays: null,
  ...over,
});

const fakeQueue = (mode: string, over: Partial<JobConfig> = {}, now?: () => Date) => {
  setEnv("FAKE_WORKER_MODE", mode);
  const c = config(over);
  return new JobQueue(c, processLauncher(c.launcher!), now);
};

async function upload(queue: JobQueue, bytes = JPEG()) {
  const result = await queue.enqueue(bytes, JPEG_KIND);
  if (!result.ok) throw new Error(result.code);
  return result.view.runId;
}

describe("upload validation", () => {
  it("recognises JPEG, PNG and WEBP by their bytes", () => {
    expect(sniffImage(JPEG())?.ext).toBe("jpg");
    expect(sniffImage(PNG())?.ext).toBe("png");
    expect(sniffImage(WEBP())?.ext).toBe("webp");
  });

  it("rejects files that are not those images, whatever they are called", () => {
    const gif = new TextEncoder().encode("GIF89a.....");
    const pdf = new TextEncoder().encode("%PDF-1.7 ....");
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const text = new TextEncoder().encode("just some text in a file named room.jpg");
    for (const bytes of [gif, pdf, svg, text]) expect(validateUpload(bytes, "image/jpeg", 1e6)).toEqual({ ok: false, status: 415, code: "wrong-type" });
  });

  it("rejects a declared type that contradicts the bytes, but allows none", () => {
    expect(validateUpload(PNG(), "image/jpeg", 1e6)).toMatchObject({ ok: false, code: "wrong-type" });
    expect(validateUpload(PNG(), "", 1e6)).toMatchObject({ ok: true, kind: { ext: "png" } });
  });

  it("enforces the size limit at the boundary, and rejects empty files", () => {
    expect(validateUpload(JPEG(100), "image/jpeg", 100)).toMatchObject({ ok: true });
    expect(validateUpload(JPEG(101), "image/jpeg", 100)).toEqual({ ok: false, status: 413, code: "too-large" });
    expect(validateUpload(new Uint8Array(), "image/jpeg", 100)).toEqual({ ok: false, status: 400, code: "not-decodable" });
  });
});

describe("run ids", () => {
  it("fit the run-id pattern and carry the stamp and digest", () => {
    const bytes = JPEG();
    const id = newRunId(bytes, new Date("2026-09-28T10:15:00.123Z"));
    const sha8 = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    expect(id).toMatch(new RegExp(`^20260928T101500Z-${sha8}-[0-9a-f]{8}$`));
    expect(RUN_ID.test(id)).toBe(true);
  });

  it("differ for the same bytes in the same second", () => {
    const now = new Date();
    const ids = new Set(Array.from({ length: 1000 }, () => newRunId(JPEG(), now)));
    expect(ids.size).toBe(1000);
  });
});

describe("configuration", () => {
  it("derives the distro, runs path and worker folder from the runs folder", () => {
    expect(parseWslPath("\\\\wsl.localhost\\Ubuntu\\home\\someone\\recon\\runs")).toEqual({ distro: "Ubuntu", linuxPath: "/home/someone/recon/runs" });
    expect(parseWslPath("\\\\wsl$\\Debian\\srv\\runs\\")).toEqual({ distro: "Debian", linuxPath: "/srv/runs" });
    expect(parseWslPath("C:\\runs")).toBeNull();
    const c = jobConfig({ DATUM_RECONSTRUCTION_RUNS: "\\\\wsl.localhost\\Ubuntu\\home\\someone\\recon\\runs" });
    expect(c?.launcher).toEqual({ kind: "wsl", distro: "Ubuntu", linuxRunsDir: "/home/someone/recon/runs", workerDir: "/home/someone/recon" });
    expect(c?.timeoutMs).toBe(300_000);
    expect(c?.retainOriginalsDays).toBeNull();
  });

  it("honours overrides, and is off without a runs folder", () => {
    expect(jobConfig({})).toBeNull();
    const c = jobConfig({
      DATUM_RECONSTRUCTION_RUNS: "\\\\wsl.localhost\\Ubuntu\\a\\runs",
      DATUM_RECONSTRUCTION_WSL_DISTRO: "Other",
      DATUM_RECONSTRUCTION_WORKER_DIR: "/opt/worker",
      DATUM_RECONSTRUCTION_TIMEOUT_MS: "90000",
      DATUM_RECONSTRUCTION_RETAIN_ORIGINALS_DAYS: "30",
    });
    expect(c?.launcher).toMatchObject({ distro: "Other", workerDir: "/opt/worker" });
    expect(c?.timeoutMs).toBe(90_000);
    expect(c?.retainOriginalsDays).toBe(30);
    expect(jobConfig({ DATUM_RECONSTRUCTION_RUNS: "C:\\runs" })?.launcher).toBeNull();
  });

  it("ignores the test worker in production unless explicitly allowed", () => {
    const env = { DATUM_RECONSTRUCTION_RUNS: "\\\\wsl.localhost\\U\\r\\runs", DATUM_RECONSTRUCTION_WORKER_COMMAND: "node fake.mjs", NODE_ENV: "production" };
    expect(jobConfig(env)?.launcher?.kind).toBe("wsl");
    expect(jobConfig({ ...env, DATUM_RECONSTRUCTION_ALLOW_TEST_WORKER: "1" })?.launcher?.kind).toBe("command");
  });

  it("launches the existing worker in its own venv, with server-made paths only", () => {
    const { command, args } = workerArgs(
      { kind: "wsl", distro: "Ubuntu", linuxRunsDir: "/home/x/recon/runs", workerDir: "/home/x/recon" },
      { runsDir: "ignored", runId: "20260928T101500Z-abcdef01-a1b2c3d4", ext: "jpg" },
    );
    expect(command).toBe("wsl.exe");
    expect(args).toEqual([
      "-d", "Ubuntu", "--cd", "/home/x/recon", "--exec", ".venv/bin/python", "-m", "reconstruction.worker",
      "--input", "/home/x/recon/runs/.jobs/20260928T101500Z-abcdef01-a1b2c3d4/original.jpg",
      "--output", "/home/x/recon/runs/20260928T101500Z-abcdef01-a1b2c3d4/reconstruction.json",
    ]);
  });
});

describe("worker outcome", () => {
  const json = (status: string, code?: string) => JSON.stringify({ diagnostics: { status, errors: code ? [{ code }] : [] } });
  const base = { exitCode: 0, spawnFailed: false, timedOut: false, runJson: null };
  it.each([
    [{ ...base, runJson: json("succeeded") }, "complete", null],
    [{ ...base, runJson: json("degraded") }, "degraded", null],
    [{ ...base, exitCode: 5, runJson: json("failed", "no-floor") }, "failed", "no-floor"],
    [{ ...base, exitCode: 4, runJson: json("failed", "gpu-oom") }, "failed", "gpu-oom"],
    [{ ...base, exitCode: 1, runJson: json("degraded") }, "failed", "worker-crashed"],
    [{ ...base, runJson: null }, "failed", "worker-crashed"],
    [{ ...base, runJson: "{ not json" }, "failed", "worker-crashed"],
    [{ ...base, exitCode: 2 }, "failed", "worker-unavailable"],
    [{ ...base, exitCode: 3 }, "failed", "worker-crashed"],
    [{ ...base, exitCode: null, spawnFailed: true }, "failed", "worker-unavailable"],
    [{ ...base, exitCode: null, timedOut: true }, "failed", "worker-timeout"],
  ])("%j → %s %s", (exit, status, code) => {
    expect(outcome(exit)).toEqual({ status, code });
  });
});

describe("job store", () => {
  const record = (runId: string): JobRecord => ({
    runId, status: "queued", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    exitCode: null, code: null, bytes: 10, sha256: "x", type: "image/jpeg", ext: "jpg",
  });

  it("keeps the original bytes exactly and never shares a job folder", async () => {
    const bytes = JPEG(5000, 42);
    await createJob(dir, record("run-a"), bytes);
    expect(readFileSync(join(jobDir(dir, "run-a"), "original.jpg")).equals(Buffer.from(bytes))).toBe(true);
    await expect(createJob(dir, record("run-a"), bytes)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readRecord(dir, "run-a")).toMatchObject({ status: "queued" });
    expect(existsSync(join(jobDir(dir, "run-a"), "job.json.part"))).toBe(false);
  });
});

describe("the job queue, with the fake worker", () => {
  it("moves a job from queued through running to complete, keeping the upload as the worker's input", async () => {
    setEnv("FAKE_WORKER_DELAY_MS", "300");
    const queue = fakeQueue("succeeded");
    const bytes = JPEG(4096, 3);
    const runId = await upload(queue, bytes);
    const first = await queue.status(runId);
    expect(["queued", "running"]).toContain(first?.status);
    await new Promise((r) => setTimeout(r, 150));
    expect((await queue.status(runId))?.status).toBe("running");
    await queue.drain();
    expect(await queue.status(runId)).toMatchObject({ status: "complete", openable: true, code: null });

    // Byte-identical: the job's original, and what the worker received as --input.
    const original = readFileSync(join(jobDir(dir, runId), "original.jpg"));
    expect(original.equals(Buffer.from(bytes))).toBe(true);
    expect(readFileSync(join(dir, runId, "source.jpg")).equals(Buffer.from(bytes))).toBe(true);
    expect(readFileSync(join(jobDir(dir, runId), "process.log"), "utf8")).toContain(join(jobDir(dir, runId), "original.jpg"));
  });

  it("keeps sourceImageId tied to the uploaded bytes through the existing compiler", async () => {
    const queue = fakeQueue("degraded");
    const bytes = JPEG(3000, 9);
    const runId = await upload(queue, bytes);
    await queue.drain();
    const parsed = parseIntermediate(JSON.parse(readFileSync(join(dir, runId, "reconstruction.json"), "utf8")));
    if (parsed.kind !== "run") throw new Error(parsed.kind);
    const result = compileRoomShell(parsed.intermediate);
    if (!result.ok) throw new Error(result.problem.code);
    const expected = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    expect(result.scene.provenance).toMatchObject({ kind: "reconstruction", sourceImageId: expected });
  });

  it("opens a degraded run rather than failing it", async () => {
    const queue = fakeQueue("degraded");
    const runId = await upload(queue);
    await queue.drain();
    expect(await queue.status(runId)).toMatchObject({ status: "degraded", openable: true });
  });

  it.each([
    ["failed", "no-floor"],
    ["crash", "worker-crashed"],
    ["exit2", "worker-unavailable"],
  ])("records a %s worker as failed with %s, keeping the diagnostics on the server", async (mode, code) => {
    const queue = fakeQueue(mode);
    const runId = await upload(queue);
    await queue.drain();
    expect(await queue.status(runId)).toMatchObject({ status: "failed", code, openable: false });
    const record = await readRecord(dir, runId);
    expect(record?.exitCode).not.toBe(0);
    expect(readFileSync(join(jobDir(dir, runId), "process.log"), "utf8").length).toBeGreaterThan(0);
  });

  it("stops a worker that runs past the watchdog", async () => {
    const queue = fakeQueue("hang", { timeoutMs: 1000 });
    const runId = await upload(queue);
    await queue.drain();
    expect(await queue.status(runId)).toMatchObject({ status: "failed", code: "worker-timeout" });
  });

  it("reports a worker that cannot be started", async () => {
    const c = config({ launcher: { kind: "command", command: join(dir, "no-such-program"), args: [] } });
    const queue = new JobQueue(c);
    const runId = await upload(queue);
    await queue.drain();
    expect(await queue.status(runId)).toMatchObject({ status: "failed", code: "worker-unavailable" });
  });

  it("runs one worker at a time, in order, each in its own folders", async () => {
    const tracePath = join(dir, "trace.txt");
    setEnv("FAKE_WORKER_TRACE", tracePath);
    setEnv("FAKE_WORKER_DELAY_MS", "200");
    const queue = fakeQueue("succeeded");
    const same = JPEG(1024, 1);
    // Arriving one after another while the first is already running.
    const ids = [await upload(queue, same), await upload(queue, same), await upload(queue, JPEG(1024, 2))];
    expect(new Set(ids).size).toBe(3);
    const positions = await Promise.all(ids.map((id) => queue.status(id)));
    expect(positions.filter((v) => v?.status === "queued").map((v) => v?.position)).toEqual([1, 2]);
    await queue.drain();

    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((l) => l.split(" "));
    expect(events.map(([e]) => e)).toEqual(["start", "end", "start", "end", "start", "end"]);
    expect(events.filter(([e]) => e === "start").map(([, id]) => id)).toEqual(ids);
    for (const id of ids) {
      expect((await queue.status(id))?.status).toBe("complete");
      const run = JSON.parse(readFileSync(join(dir, id, "reconstruction.json"), "utf8"));
      expect(run.jobId).toBe(id);
    }
  });

  it("keeps answering, and keeps its records, while status is read continuously", async () => {
    setEnv("FAKE_WORKER_DELAY_MS", "100");
    const queue = fakeQueue("succeeded");
    const ids = [await upload(queue), await upload(queue), await upload(queue)];
    let polling = true;
    const misses: string[] = [];
    const pollers = Array.from({ length: 8 }, async () => {
      while (polling) {
        for (const id of ids) if (!(await queue.status(id))) misses.push(id);
        await new Promise((r) => setTimeout(r, 10));
      }
    });
    await queue.drain();
    polling = false;
    await Promise.all(pollers);
    expect(misses).toEqual([]);
    for (const id of ids) expect((await queue.status(id))?.status).toBe("complete");
  }, 20_000);

  it("refuses more than the queue will hold", async () => {
    setEnv("FAKE_WORKER_DELAY_MS", "500");
    const queue = fakeQueue("succeeded", { maxQueued: 1 });
    await upload(queue);
    await upload(queue);
    const third = await queue.enqueue(JPEG(), JPEG_KIND);
    expect(third).toEqual({ ok: false, status: 429, code: "busy" });
    await queue.drain();
  });
});

describe("after a restart", () => {
  const seed = async (runId: string, status: JobRecord["status"], extra: Partial<JobRecord> = {}) => {
    await createJob(dir, {
      runId, status, createdAt: new Date(Date.now() - 1000).toISOString(), startedAt: null, finishedAt: null,
      exitCode: null, code: null, bytes: 1, sha256: "x", type: "image/jpeg", ext: "jpg", ...extra,
    }, JPEG());
  };

  it("requeues waiting jobs and settles the ones that were running", async () => {
    await seed("was-queued", "queued");
    await seed("was-running-done", "running");
    mkdirSync(join(dir, "was-running-done"));
    writeFileSync(join(dir, "was-running-done", "reconstruction.json"), JSON.stringify({ diagnostics: { status: "degraded", errors: [] } }));
    await seed("was-running-lost", "running");

    const queue = fakeQueue("succeeded");
    await queue.drain();
    expect(await queue.status("was-queued")).toMatchObject({ status: "complete" });
    expect(await queue.status("was-running-done")).toMatchObject({ status: "degraded", openable: true });
    expect(await queue.status("was-running-lost")).toMatchObject({ status: "failed", code: "interrupted" });
  });

  it("answers for runs made with the CLI, which have no job", async () => {
    mkdirSync(join(dir, "20260922T065240Z-2d25a689"));
    writeFileSync(join(dir, "20260922T065240Z-2d25a689", "reconstruction.json"), JSON.stringify({ diagnostics: { status: "degraded", errors: [] } }));
    const queue = fakeQueue("succeeded");
    expect(await queue.status("20260922T065240Z-2d25a689")).toMatchObject({ status: "degraded", openable: true });
    expect(await queue.status("nothing-here")).toBeNull();
  });
});

describe("cleanup", () => {
  it("removes expired failed jobs and orphaned uploads, never runs or kept originals", async () => {
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const base = { createdAt: old, startedAt: old, exitCode: 1, bytes: 1, sha256: "x", type: "image/jpeg", ext: "jpg" };
    await createJob(dir, { ...base, runId: "old-failed", status: "failed", finishedAt: old, code: "no-floor" }, JPEG());
    await createJob(dir, { ...base, runId: "new-failed", status: "failed", finishedAt: new Date().toISOString(), code: "no-floor" }, JPEG());
    await createJob(dir, { ...base, runId: "old-complete", status: "complete", finishedAt: old, code: null, exitCode: 0 }, JPEG());
    mkdirSync(join(dir, "old-failed"));
    writeFileSync(join(dir, "old-failed", "worker.log"), "kept");
    const orphan = jobDir(dir, "orphan");
    mkdirSync(orphan);
    const twoHoursAgo = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(orphan, twoHoursAgo, twoHoursAgo);

    await new JobQueue(config()).cleanup();
    expect(existsSync(jobDir(dir, "old-failed"))).toBe(false);
    expect(existsSync(join(dir, "old-failed", "worker.log"))).toBe(true);
    expect(existsSync(jobDir(dir, "new-failed"))).toBe(true);
    expect(existsSync(join(jobDir(dir, "old-complete"), "original.jpg"))).toBe(true);
    expect(existsSync(orphan)).toBe(false);

    // With a retention period set, a finished run's original goes; its record stays.
    await new JobQueue(config({ retainOriginalsDays: 7 })).cleanup();
    expect(existsSync(join(jobDir(dir, "old-complete"), "original.jpg"))).toBe(false);
    expect(await readRecord(dir, "old-complete")).toMatchObject({ status: "complete" });
  });
});

describe("the endpoints", () => {
  const post = (body: FormData | string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/reconstructions/local/jobs", { method: "POST", body, headers });
  const form = (bytes: Uint8Array, type = "image/jpeg") => {
    const f = new FormData();
    f.append("photo", new Blob([new Uint8Array(bytes)], { type }), "C:\\Users\\someone\\room.jpg");
    return f;
  };
  const leaks = (text: string) => {
    expect(text).not.toContain("\\");
    expect(text).not.toContain(dir);
    expect(text).not.toMatch(/\/home\/|wsl|\.jobs|original\./i);
  };

  it("queue an upload and return at once, then report its progress", async () => {
    setEnv("FAKE_WORKER_DELAY_MS", "300");
    const queue = fakeQueue("succeeded");
    const resolve = () => ({ config: queue.config, queue });
    const response = await enqueueUpload(post(form(JPEG())), resolve);
    expect(response.status).toBe(202);
    const text = await response.text();
    leaks(text);
    const { runId, status } = JSON.parse(text);
    expect(RUN_ID.test(runId)).toBe(true);
    expect(status).toBe("queued");
    await queue.drain();
    const done = await jobStatus(runId, resolve);
    const doneText = await done.text();
    leaks(doneText);
    expect(JSON.parse(doneText)).toMatchObject({ status: "complete", openable: true });
    expect(done.headers.get("cache-control")).toBe("no-store");
  });

  it("refuse what should not reach the worker", async () => {
    const queue = fakeQueue("succeeded");
    const resolve = () => ({ config: queue.config, queue });
    const pdf = new TextEncoder().encode("%PDF-1.7");
    const cases: [Request, number, string][] = [
      [post(form(pdf, "image/jpeg")), 415, "wrong-type"],
      [post(form(JPEG(2000)), { "content-length": String(30 * 1024 * 1024) }), 413, "too-large"],
      [post("not a form", { "content-type": "text/plain" }), 400, "upload-invalid"],
      [post(new FormData()), 400, "upload-invalid"],
    ];
    for (const [request, status, code] of cases) {
      const response = await enqueueUpload(request, resolve);
      expect([response.status, (await response.json()).code]).toEqual([status, code]);
    }
    const big = await enqueueUpload(post(form(JPEG(2000))), () => ({ config: { ...queue.config, maxBytes: 1000 }, queue }));
    expect(big.status).toBe(413);
    expect(await (await jobStatus("../etc", resolve)).json()).toEqual({ code: "not-found" });
    expect((await jobStatus("20990101T000000Z-00000000-00000000", resolve)).status).toBe(404);
  });

  it("are off where no runs folder is configured", async () => {
    setEnv("DATUM_RECONSTRUCTION_RUNS", undefined);
    expect((await enqueueUpload(post(form(JPEG())))).status).toBe(404);
    expect((await jobStatus("anything")).status).toBe(404);
  });

  it("leave the job folder out of the run list", async () => {
    const queue = fakeQueue("succeeded");
    const runId = await upload(queue);
    await queue.drain();
    setEnv("DATUM_RECONSTRUCTION_RUNS", dir);
    const { runs } = await (await listRuns()).json();
    expect(runs.map((r: { runId: string }) => r.runId)).toEqual([runId]);
  });
});

