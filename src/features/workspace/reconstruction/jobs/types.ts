/**
 * A reconstruction job: one uploaded photograph on its way through the
 * existing worker. Shared by the server and the browser, so nothing here
 * may carry a path, a log line or a configuration value.
 */

export type JobStatus = "queued" | "running" | "complete" | "degraded" | "failed";

export const FINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(["complete", "degraded", "failed"]);

/** What the status endpoint answers. Codes only; the words live in `problemCopy`. */
export interface JobView {
  runId: string;
  status: JobStatus;
  /** Place in the queue while queued, 1 being next. */
  position: number | null;
  code: string | null;
  /** Complete and degraded runs both open in the workspace. */
  openable: boolean;
  elapsedMs: number | null;
}

/** `job.json`, server-side only. */
export interface JobRecord {
  runId: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  code: string | null;
  bytes: number;
  sha256: string;
  type: string;
  ext: string;
}
