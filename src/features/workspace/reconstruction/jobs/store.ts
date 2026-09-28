import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { JobRecord } from "./types";

/**
 * Where jobs live: `<runs>/.jobs/<runId>/`. The leading dot keeps the folder
 * out of the run list and the run-file route, whose ids cannot start with
 * one. Each job holds the photograph exactly as uploaded, its `job.json`,
 * and the worker's console output. The run itself is written by the worker
 * into `<runs>/<runId>/`, which nothing here creates.
 */

export const JOBS_FOLDER = ".jobs";

export const jobsDir = (runsDir: string) => join(/*turbopackIgnore: true*/ runsDir, JOBS_FOLDER);
export const jobDir = (runsDir: string, runId: string) => join(/*turbopackIgnore: true*/ jobsDir(runsDir), runId);
export const originalName = (ext: string) => `original.${ext}`;
export const runJsonPath = (runsDir: string, runId: string) =>
  join(/*turbopackIgnore: true*/ runsDir, runId, "reconstruction.json");

/** Windows refuses to replace a file another handle has open (a status read, say) for a moment. */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

async function writeAtomic(path: string, data: string | Uint8Array) {
  const part = `${path}.part`;
  await writeFile(part, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(part, path);
      return;
    } catch (error) {
      if (!TRANSIENT.has((error as { code?: string }).code ?? "") || attempt >= 20) throw error;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

/**
 * Create a job's folder and keep the photograph in it. The folder is made
 * without `recursive`, so an id already taken fails with EEXIST instead of
 * sharing a folder with another job.
 */
export async function createJob(runsDir: string, record: JobRecord, bytes: Uint8Array): Promise<void> {
  await mkdir(jobsDir(runsDir), { recursive: true });
  const dir = jobDir(runsDir, record.runId);
  await mkdir(dir);
  await writeAtomic(join(/*turbopackIgnore: true*/ dir, originalName(record.ext)), bytes);
  await writeRecord(runsDir, record);
}

export const writeRecord = (runsDir: string, record: JobRecord) =>
  writeAtomic(join(/*turbopackIgnore: true*/ jobDir(runsDir, record.runId), "job.json"), JSON.stringify(record, null, 1));

export async function readRecord(runsDir: string, runId: string): Promise<JobRecord | null> {
  const path = join(/*turbopackIgnore: true*/ jobDir(runsDir, runId), "job.json");
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      // Being replaced at this instant: ask again rather than report it missing.
      if (!TRANSIENT.has((error as { code?: string }).code ?? "") || attempt >= 20) return null;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

/** Every job folder, with its record when it has a readable one. */
export async function listJobs(runsDir: string): Promise<{ runId: string; record: JobRecord | null; modifiedMs: number }[]> {
  let names: string[];
  try {
    names = (await readdir(jobsDir(runsDir), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const jobs = [];
  for (const runId of names) {
    const modifiedMs = await stat(jobDir(runsDir, runId)).then((s) => s.mtimeMs, () => 0);
    jobs.push({ runId, record: await readRecord(runsDir, runId), modifiedMs });
  }
  return jobs;
}

/** The run's intermediate as text, or null while the worker has not written it. */
export async function readRunJson(runsDir: string, runId: string): Promise<string | null> {
  try {
    return await readFile(runJsonPath(runsDir, runId), "utf8");
  } catch {
    return null;
  }
}

/** Remove a path inside `.jobs`, and only there. */
export async function removeInsideJobs(runsDir: string, path: string): Promise<void> {
  const root = resolve(jobsDir(runsDir)) + sep;
  const target = resolve(path);
  if (!target.startsWith(root)) throw new Error("refusing to remove outside the jobs folder");
  await rm(target, { recursive: true, force: true });
}
