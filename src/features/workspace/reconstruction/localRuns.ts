import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reconstruction runs on this machine, read straight from the directory the
 * worker writes to (DATUM_RECONSTRUCTION_RUNS, e.g. the WSL runs folder as
 * Windows sees it). Development-only by construction: with the variable
 * unset, as it is in any deployment, every call answers "not configured".
 *
 * Only named files are served, and a run id can never climb out of the
 * runs directory.
 */

export const RUN_FILES = {
  "reconstruction.json": "application/json",
  "calibration.json": "application/json",
  "source.jpg": "image/jpeg",
  "depth-preview.png": "image/png",
  "planes-preview.png": "image/png",
} as const;

export type RunFile = keyof typeof RUN_FILES;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export interface RunSummary {
  runId: string;
  createdAt: string | null;
  status: string | null;
  pipelineVersion: string | null;
  image: { width: number; height: number } | null;
  planes: Record<string, number>;
}

function runsDir(): string | null {
  return process.env.DATUM_RECONSTRUCTION_RUNS?.trim() || null;
}

const noStore = { "Cache-Control": "no-store" };

function problem(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status, headers: noStore });
}

export async function listRuns(): Promise<Response> {
  const dir = runsDir();
  if (!dir) return problem(404, "not-configured", "DATUM_RECONSTRUCTION_RUNS is not set.");
  let names: string[];
  try {
    const entries = await readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && RUN_ID.test(e.name)).map((e) => e.name);
  } catch {
    return problem(404, "not-found", "The runs directory cannot be read.");
  }
  const runs: RunSummary[] = [];
  for (const runId of names) {
    try {
      const json = JSON.parse(await readFile(join(/*turbopackIgnore: true*/ dir, runId, "reconstruction.json"), "utf8"));
      const planes: Record<string, number> = {};
      for (const p of json.world?.planes ?? []) planes[p.role] = (planes[p.role] ?? 0) + 1;
      runs.push({
        runId,
        createdAt: typeof json.createdAt === "string" ? json.createdAt : null,
        status: json.diagnostics?.status ?? null,
        pipelineVersion: json.pipeline?.version ?? null,
        image: json.source ? { width: json.source.width, height: json.source.height } : null,
        planes,
      });
    } catch {
      // A run still being written, or one that never finished: not listed.
    }
  }
  runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return Response.json({ runs }, { headers: noStore });
}

export async function readRunFile(runId: string, file: string): Promise<Response> {
  const dir = runsDir();
  if (!dir) return problem(404, "not-configured", "DATUM_RECONSTRUCTION_RUNS is not set.");
  if (!RUN_ID.test(runId) || !(file in RUN_FILES)) return problem(404, "not-found", "No such run file.");
  // The runs folder lives outside the project on purpose; nothing in it is bundled.
  const path = join(/*turbopackIgnore: true*/ dir, runId, file);
  try {
    if (!(await stat(path)).isFile()) return problem(404, "not-found", "No such run file.");
    const body = await readFile(path);
    return new Response(new Uint8Array(body), {
      headers: { "Content-Type": RUN_FILES[file as RunFile], ...noStore },
    });
  } catch {
    return problem(404, "not-found", "No such run file.");
  }
}
