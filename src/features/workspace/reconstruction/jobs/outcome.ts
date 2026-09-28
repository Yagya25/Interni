import type { JobStatus } from "./types";

export interface WorkerExit {
  exitCode: number | null;
  /** The process could not be started at all. */
  spawnFailed: boolean;
  timedOut: boolean;
  /** The run's reconstruction.json, when the worker wrote one. */
  runJson: string | null;
}

/**
 * How a finished worker process becomes a job status. The intermediate the
 * worker wrote is the authority whenever there is one: it records failures
 * as well as successes, with the code the browser shows.
 */
export function outcome(exit: WorkerExit): { status: Exclude<JobStatus, "queued" | "running">; code: string | null } {
  if (exit.spawnFailed) return { status: "failed", code: "worker-unavailable" };
  if (exit.timedOut) return { status: "failed", code: "worker-timeout" };

  const fromJson = exit.runJson === null ? null : statusFromRunJson(exit.runJson);
  if (fromJson) {
    // A finished run with an abnormal exit is still what the worker recorded.
    if (fromJson.status !== "failed" && exit.exitCode !== 0) return { status: "failed", code: "worker-crashed" };
    return fromJson;
  }
  if (exit.exitCode === 2) return { status: "failed", code: "worker-unavailable" };
  return { status: "failed", code: "worker-crashed" };
}

/** Read `diagnostics.status` (and the first error's code) from an intermediate. Null when unreadable. */
export function statusFromRunJson(text: string): { status: "complete" | "degraded" | "failed"; code: string | null } | null {
  let json: { diagnostics?: { status?: unknown; errors?: { code?: unknown }[] } };
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const d = json?.diagnostics;
  if (d?.status === "succeeded") return { status: "complete", code: null };
  if (d?.status === "degraded") return { status: "degraded", code: null };
  if (d?.status === "failed") {
    const code = d.errors?.[0]?.code;
    return { status: "failed", code: typeof code === "string" ? code : "worker-failed" };
  }
  return null;
}
