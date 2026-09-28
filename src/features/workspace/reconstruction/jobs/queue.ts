import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { JobConfig } from "./config";
import { processLauncher, type Launcher, type RunningWorker } from "./launcher";
import { outcome, statusFromRunJson } from "./outcome";
import { newRunId } from "./runId";
import {
  createJob,
  jobDir,
  listJobs,
  originalName,
  readRecord,
  readRunJson,
  removeInsideJobs,
  writeRecord,
} from "./store";
import { FINAL_STATUSES, type JobRecord, type JobView } from "./types";
import type { ImageKind } from "./validate";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A job folder with no record this old is an upload that never finished arriving. */
const ORPHAN_MS = 60 * 60 * 1000;

export type Enqueued = { ok: true; view: JobView } | { ok: false; status: number; code: string };

/**
 * One reconstruction at a time, in the order they arrive: there is one GPU,
 * and two runs would fight over its memory. The worker process belongs to
 * this queue, not to the request that asked for it, so a request returns as
 * soon as its job is recorded. Everything the queue knows is also on disk
 * in `job.json`, so a restarted server can pick up where it left off.
 */
export class JobQueue {
  private waiting: string[] = [];
  private running: { runId: string; worker: RunningWorker | null } | null = null;
  private recovered: Promise<void> | null = null;
  /** Settles when the job currently running has been recorded as finished (tests wait on it). */
  idle: Promise<void> = Promise.resolve();

  constructor(
    readonly config: JobConfig,
    private readonly launcher: Launcher | null = config.launcher ? processLauncher(config.launcher) : null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Take in a validated photograph and queue it. Returns as soon as it is recorded. */
  async enqueue(bytes: Uint8Array, kind: ImageKind): Promise<Enqueued> {
    await this.recover();
    if (!this.launcher) return { ok: false, status: 503, code: "worker-unavailable" };
    if (this.waiting.length >= this.config.maxQueued) return { ok: false, status: 429, code: "busy" };

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    for (let attempt = 0; ; attempt++) {
      const record: JobRecord = {
        runId: newRunId(bytes, this.now()),
        status: "queued",
        createdAt: this.now().toISOString(),
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        code: null,
        bytes: bytes.length,
        sha256,
        type: kind.type,
        ext: kind.ext,
      };
      try {
        await createJob(this.config.runsDir, record, bytes);
      } catch (error) {
        if ((error as { code?: string }).code === "EEXIST" && attempt < 2) continue;
        throw error;
      }
      this.waiting.push(record.runId);
      const view = this.view(record);
      this.pump();
      return { ok: true, view };
    }
  }

  /** Settles once nothing is running or waiting. */
  async drain(): Promise<void> {
    await this.recover();
    while (this.running || this.waiting.length) await this.idle;
  }

  /** A job's status; for a run made outside the queue (the CLI), read from the run itself. */
  async status(runId: string): Promise<JobView | null> {
    await this.recover();
    const record = await readRecord(this.config.runsDir, runId);
    if (record) return this.view(record);
    const text = await readRunJson(this.config.runsDir, runId);
    const found = text === null ? null : statusFromRunJson(text);
    if (!found) return null;
    return { runId, status: found.status, position: null, code: found.code, openable: found.status !== "failed", elapsedMs: null };
  }

  private view(record: JobRecord): JobView {
    const index = this.waiting.indexOf(record.runId);
    const started = record.startedAt ? Date.parse(record.startedAt) : null;
    const ended = record.finishedAt ? Date.parse(record.finishedAt) : this.now().getTime();
    // Claimed by the worker slot but not yet recorded as started: it is starting.
    const status = record.status === "queued" && this.running?.runId === record.runId ? "running" : record.status;
    return {
      runId: record.runId,
      status,
      position: status === "queued" && index >= 0 ? index + 1 : null,
      code: record.code,
      openable: record.status === "complete" || record.status === "degraded",
      elapsedMs: started === null ? null : Math.max(0, ended - started),
    };
  }

  private pump(): void {
    if (this.running || !this.launcher) return;
    const runId = this.waiting.shift();
    if (!runId) return;
    // Claimed before anything is awaited, so a second pump cannot start a second worker.
    this.running = { runId, worker: null };
    this.idle = this.run(runId).catch(async (error) => {
      console.error(`[reconstruction-job] ${runId} could not be run:`, error);
      await this.settleBroken(runId);
    }).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  /** A job whose bookkeeping failed is still given an ending: the run's own verdict if it has one, or failed. */
  private async settleBroken(runId: string): Promise<void> {
    const { runsDir } = this.config;
    try {
      const record = await readRecord(runsDir, runId);
      if (!record || FINAL_STATUSES.has(record.status)) return;
      const found = statusFromRunJson((await readRunJson(runsDir, runId)) ?? "");
      Object.assign(record, { status: found?.status ?? "failed", code: found ? found.code : "job-error", finishedAt: this.now().toISOString() });
      await writeRecord(runsDir, record);
    } catch (error) {
      console.error(`[reconstruction-job] ${runId} could not be settled:`, error);
    }
  }

  private async run(runId: string): Promise<void> {
    const { runsDir } = this.config;
    const record = await readRecord(runsDir, runId);
    if (!record || record.status !== "queued") return;

    record.status = "running";
    record.startedAt = this.now().toISOString();
    await writeRecord(runsDir, record);

    const worker = this.launcher!.start({ runsDir, runId, ext: record.ext });
    this.running = { runId, worker };
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      worker.kill();
    }, this.config.timeoutMs);
    const exit = await worker.done;
    clearTimeout(watchdog);

    const result = outcome({ ...exit, timedOut, runJson: await readRunJson(runsDir, runId) });
    Object.assign(record, { status: result.status, code: result.code, exitCode: exit.exitCode, finishedAt: this.now().toISOString() });
    await writeRecord(runsDir, record);
    if (result.status === "failed") {
      console.error(`[reconstruction-job] ${runId} failed: ${result.code} (exit ${exit.exitCode}${timedOut ? ", timed out" : ""})`);
    }
    await this.cleanup();
  }

  /**
   * Once per process: requeue what was waiting, settle what was running
   * when the last server stopped (its worker went with it), and tidy up.
   */
  recover(): Promise<void> {
    this.recovered ??= (async () => {
      const { runsDir } = this.config;
      const jobs = await listJobs(runsDir);
      const queued = [];
      for (const { runId, record } of jobs) {
        if (!record || runId === this.running?.runId || this.waiting.includes(runId)) continue;
        if (record.status === "queued") queued.push(record);
        if (record.status === "running") {
          const found = statusFromRunJson((await readRunJson(runsDir, runId)) ?? "");
          Object.assign(record, {
            status: found?.status ?? "failed",
            code: found ? found.code : "interrupted",
            finishedAt: this.now().toISOString(),
          });
          await writeRecord(runsDir, record);
        }
      }
      queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.waiting.push(...queued.map((r) => r.runId));
      await this.cleanup();
      this.pump();
    })();
    return this.recovered;
  }

  /**
   * Retention, and nothing else. Only ever inside `.jobs`; run folders are
   * the worker's record and are never touched.
   *   - a folder with no record, older than an hour: an upload that never landed
   *   - a failed job past retainFailedDays: its whole folder
   *   - a finished run's original past retainOriginalsDays (when set): the file only
   */
  async cleanup(): Promise<void> {
    const { runsDir, retainFailedDays, retainOriginalsDays } = this.config;
    const now = this.now().getTime();
    for (const { runId, record, modifiedMs } of await listJobs(runsDir)) {
      if (runId === this.running?.runId || this.waiting.includes(runId)) continue;
      try {
        if (!record) {
          if (now - modifiedMs > ORPHAN_MS) await removeInsideJobs(runsDir, jobDir(runsDir, runId));
          continue;
        }
        if (!FINAL_STATUSES.has(record.status) || !record.finishedAt) continue;
        const age = now - Date.parse(record.finishedAt);
        if (record.status === "failed" && age > retainFailedDays * DAY_MS) {
          await removeInsideJobs(runsDir, jobDir(runsDir, runId));
        } else if (record.status !== "failed" && retainOriginalsDays !== null && age > retainOriginalsDays * DAY_MS) {
          const original = join(/*turbopackIgnore: true*/ jobDir(runsDir, runId), originalName(record.ext));
          if (await stat(original).then(() => true, () => false)) await removeInsideJobs(runsDir, original);
        }
      } catch (error) {
        console.error(`[reconstruction-job] cleanup of ${runId} failed:`, error);
      }
    }
  }
}

const QUEUES = Symbol.for("datum.reconstructionJobQueues");
type Registry = Map<string, JobQueue>;

/**
 * The process-wide queue for a runs folder. Held on globalThis so a module
 * reload in development cannot start a second queue, and a second GPU job.
 */
export function queueFor(config: JobConfig): JobQueue {
  const registry = ((globalThis as Record<symbol, Registry | undefined>)[QUEUES] ??= new Map());
  let queue = registry.get(config.runsDir);
  if (!queue) registry.set(config.runsDir, (queue = new JobQueue(config)));
  return queue;
}
