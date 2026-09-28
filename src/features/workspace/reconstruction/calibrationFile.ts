import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCalibration, solveScale, type CalibrationReference } from "@/scene/compile/calibration";
import { parseIntermediate } from "@/scene/compile/intermediate";
import { RUN_ID } from "./localRuns";

/**
 * Saving a run's calibration from the workspace: the same `calibration.json`
 * (schema 1) that `python -m reconstruction.calibrate` writes, beside the
 * run's reconstruction.json, under the same rule — a calibration is never
 * replaced silently: the file it replaces is kept as `calibration.<n>.json`.
 *
 * The references are checked against the run's own intermediate with the
 * compiler's `solveScale` before anything is written, so a saved file is one
 * the compiler will accept in full. An empty list removes the calibration
 * (the room goes back to its estimated scale); the old file is still kept.
 * Development-only, like the rest of /api/reconstructions/local.
 */

const noStore = { "Cache-Control": "no-store" };
const MAX_REFERENCES = 20;

function problem(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status, headers: noStore });
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** Keep the current calibration as the next free calibration.<n>.json, as the worker's CLI does. */
async function keepPrevious(run: string): Promise<string | null> {
  const current = join(/*turbopackIgnore: true*/ run, "calibration.json");
  if (!(await exists(current))) return null;
  const taken = new Set(await readdir(run));
  let n = 1;
  while (taken.has(`calibration.${n}.json`)) n++;
  const kept = `calibration.${n}.json`;
  await writeFile(join(/*turbopackIgnore: true*/ run, kept), await readFile(current));
  return kept;
}

export async function saveCalibration(runId: string, body: unknown, runsDir = process.env.DATUM_RECONSTRUCTION_RUNS?.trim()): Promise<Response> {
  if (!runsDir) return problem(404, "not-configured", "DATUM_RECONSTRUCTION_RUNS is not set.");
  if (!RUN_ID.test(runId)) return problem(404, "not-found", "No such run.");
  const run = join(/*turbopackIgnore: true*/ runsDir, runId);

  const file = parseCalibration(body);
  if (typeof file === "string") return problem(400, "invalid-calibration", file);
  if (file.references.length > MAX_REFERENCES) return problem(400, "invalid-calibration", `At most ${MAX_REFERENCES} references.`);

  let text: string;
  try {
    text = await readFile(join(/*turbopackIgnore: true*/ run, "reconstruction.json"), "utf8");
  } catch {
    return problem(404, "not-found", "No such run.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return problem(409, "not-calibratable", "The run's reconstruction can't be read.");
  }
  const parsed = parseIntermediate(json);
  if (parsed.kind !== "run") return problem(409, "not-calibratable", "This run has no reconstruction to calibrate.");

  // Only what the compiler will use in full is written: nothing is accepted and then quietly dropped.
  const references: CalibrationReference[] = file.references.map(clean);
  const solution = solveScale(parsed.intermediate, references);
  if (solution.rejected.length) {
    return problem(422, "reference-rejected", `A reference can't be used: ${solution.rejected[0].reason}.`);
  }

  try {
    const kept = await keepPrevious(run);
    const target = join(/*turbopackIgnore: true*/ run, "calibration.json");
    if (references.length === 0) {
      await rm(target, { force: true });
    } else {
      const part = `${target}.part`;
      await writeFile(part, JSON.stringify({ schemaVersion: 1, references }, null, 1));
      await rename(part, target);
    }
    return Response.json(
      { references, factor: solution.factor, basis: solution.basis, kept },
      { headers: noStore },
    );
  } catch (error) {
    console.error(`[calibration] ${runId} could not be saved:`, error);
    return problem(500, "unwritable", "The calibration could not be written to the run.");
  }
}

/** Only the fields the schema defines, so nothing else is ever written into the run. */
function clean(r: CalibrationReference): CalibrationReference {
  const label = typeof r.label === "string" && r.label.trim() ? { label: r.label.trim().slice(0, 80) } : {};
  return r.kind === "room-height"
    ? { kind: "room-height", metres: r.metres, ...label }
    : { kind: "on-plane", planeId: r.planeId, a: [r.a[0], r.a[1]], b: [r.b[0], r.b[1]], metres: r.metres, ...label };
}
