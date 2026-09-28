import {
  compileRoomShell,
  parseCalibration,
  parseIntermediate,
  type CalibrationReference,
  type CompileResult,
  type ReconstructionIntermediate,
} from "@/scene/compile";

export const runFileUrl = (runId: string, file: string) =>
  `/api/reconstructions/local/${encodeURIComponent(runId)}/${file}`;

export type RunState =
  | { status: "loading" }
  | { status: "unavailable"; code: string }
  | { status: "failed"; code: string }
  | {
      status: "compiled";
      intermediate: ReconstructionIntermediate;
      calibration: readonly CalibrationReference[];
      /**
       * Why a calibration the run has could not be used, or null. A run with
       * no calibration at all has none to report: its scale is simply estimated.
       */
      calibrationProblem: string | null;
      result: CompileResult;
    };

/**
 * Fetch a run, and compile it here in the browser. The intermediate is what
 * the worker observed; the Scene is made from it on the spot, so a new
 * calibration or a new compiler version never needs the GPU again.
 */
export async function loadRun(runId: string): Promise<RunState> {
  const response = await fetch(runFileUrl(runId, "reconstruction.json"), { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return { status: "unavailable", code: body?.code ?? "not-found" };
  }
  const parsed = parseIntermediate(await response.json());
  if (parsed.kind === "invalid") {
    console.error("[reconstruction] invalid intermediate:", parsed.reason);
    return { status: "failed", code: "invalid-intermediate" };
  }
  if (parsed.kind === "failed") {
    return { status: "failed", code: parsed.run.diagnostics.errors[0]?.code ?? "worker-failed" };
  }

  const { references: calibration, problem: calibrationProblem } = await readCalibration(runId);
  const result = compileRoomShell(parsed.intermediate, { calibration });
  return { status: "compiled", intermediate: parsed.intermediate, calibration, calibrationProblem, result };
}

/**
 * A run's calibration, if it has one. Three different answers, kept apart:
 * none measured (204, the usual case — the room's scale stays estimated,
 * and nothing is wrong); one measured and read; or one that could not be
 * fetched, read or understood — which is reported, in the console and to
 * the workspace, rather than quietly treated as "not calibrated".
 */
async function readCalibration(runId: string): Promise<{ references: readonly CalibrationReference[]; problem: string | null }> {
  const failed = (problem: string) => {
    console.error(`[reconstruction] ${problem}`);
    return { references: [], problem };
  };
  let response: Response;
  try {
    response = await fetch(runFileUrl(runId, "calibration.json"), { cache: "no-store" });
  } catch (error) {
    return failed(`calibration.json could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 204) return { references: [], problem: null };
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return failed(`calibration.json could not be read (HTTP ${response.status}${body?.code ? `, ${body.code}` : ""})`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return failed("calibration.json is not valid JSON");
  }
  const file = parseCalibration(json);
  if (typeof file === "string") return failed(`calibration.json was ignored: ${file}`);
  return { references: file.references, problem: null };
}

/** What a person reads when a run can't be shown. Looked up by code, never built from an error. */
export const RUN_PROBLEMS: Record<string, { title: string; detail: string }> = {
  "not-configured": {
    title: "Local reconstructions aren't connected here.",
    detail: "This page reads reconstructions from this machine. Set DATUM_RECONSTRUCTION_RUNS to the worker's runs folder and restart the dev server.",
  },
  "not-found": { title: "There is no reconstruction with that name.", detail: "It may have been removed, or the link is incomplete." },
  "no-floor": { title: "The floor isn't visible enough to rebuild the room.", detail: "A photograph taken from a corner at about eye height, with plenty of floor in shot, works best." },
  "degenerate-room": { title: "The room came out too small to be a room.", detail: "The depth read from this photograph doesn't enclose a space. Try another photograph." },
  "ceiling-below-camera": { title: "The fitted ceiling is below the camera.", detail: "The depth read from this photograph is inconsistent. Try another photograph." },
  "too-small": { title: "That image is too small.", detail: "Its shortest side needs at least 640 pixels." },
  "too-large": { title: "That image is too large.", detail: "It must be under 24 MB and 50 megapixels." },
  "wrong-type": { title: "That file isn't a JPEG, PNG or WEBP image.", detail: "Try exporting the photograph as a JPEG." },
  "not-decodable": { title: "That image couldn't be read.", detail: "The file may be damaged." },
  "gpu-oom": { title: "The reconstruction ran out of graphics memory.", detail: "The worker's log records how much it needed." },
  "model-integrity": { title: "A model file didn't match its pinned hash.", detail: "The worker refused to run it. The worker's log names the file." },
  // Phase 7: sending a photograph to the worker.
  "worker-unavailable": { title: "The reconstruction worker couldn't be started.", detail: "It runs in WSL on this machine, on the graphics card. The job's log on this machine records why it didn't start." },
  "worker-crashed": { title: "The reconstruction worker stopped unexpectedly.", detail: "It didn't finish writing a result. The job's log on this machine records what happened." },
  "worker-timeout": { title: "The reconstruction took too long and was stopped.", detail: "Try again; if it keeps happening, the job's log on this machine shows where it stalled." },
  "job-error": { title: "The reconstruction job couldn't be tracked.", detail: "The server couldn't record its progress in the runs folder. Try again." },
  interrupted: { title: "The reconstruction was interrupted.", detail: "The server stopped while it was running. Try again." },
  busy: { title: "Several reconstructions are already waiting.", detail: "Try again once one of them has finished." },
  "upload-invalid": { title: "The photograph didn't arrive.", detail: "Try sending it again." },
  "upload-failed": { title: "The photograph couldn't be kept for reconstruction.", detail: "The server couldn't write it to the runs folder." },
  unreachable: { title: "The server couldn't be reached.", detail: "Check that the dev server is still running." },
};

export const problemCopy = (code: string) =>
  RUN_PROBLEMS[code] ?? { title: "This reconstruction couldn't be opened.", detail: `The problem was recorded as “${code}”.` };
