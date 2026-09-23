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

  let calibration: readonly CalibrationReference[] = [];
  const cal = await fetch(runFileUrl(runId, "calibration.json"), { cache: "no-store" });
  if (cal.ok) {
    const file = parseCalibration(await cal.json());
    if (typeof file === "string") {
      console.error("[reconstruction] calibration.json ignored:", file);
    } else {
      calibration = file.references;
    }
  }
  const result = compileRoomShell(parsed.intermediate, { calibration });
  return { status: "compiled", intermediate: parsed.intermediate, calibration, result };
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
};

export const problemCopy = (code: string) =>
  RUN_PROBLEMS[code] ?? { title: "This reconstruction couldn't be opened.", detail: `The problem was recorded as “${code}”.` };
