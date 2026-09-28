import type { Problem } from "@/scene/compile/intermediate";

/**
 * What a person should know about how a reconstruction went, in words, from
 * the worker's own diagnostics. Nothing here is inferred: each reason is a
 * warning or error the worker recorded, told with the numbers it recorded.
 * A degraded run is said to be degraded; a calibrated one is not claimed to
 * be more than its calibration makes it.
 */

export interface RunDiagnostics {
  status: "succeeded" | "degraded" | "failed";
  warnings: readonly Problem[];
  errors: readonly Problem[];
}

export interface Explanation {
  status: RunDiagnostics["status"];
  /** One sentence: how the reconstruction went. */
  headline: string;
  reasons: readonly { code: string; stage: string; text: string }[];
  /** What calibration does and does not settle here. Null when the scale is still estimated. */
  calibrated: string | null;
  /** The useful next step, when there is one. */
  action: { kind: "calibrate"; label: string } | null;
}

const CALIBRATE = { kind: "calibrate", label: "Calibrate a known distance" } as const;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One recorded problem, told plainly with the values the worker gave. */
export function describeProblem(p: Problem): string {
  if (p.code === "fov-disagreement") {
    const geo = num(p.detail?.geocalib);
    const moge = num(p.detail?.moge);
    if (geo !== null && moge !== null) {
      return (
        `GeoCalib's field of view (${geo.toFixed(1)}°) and MoGe-2's (${moge.toFixed(1)}°) disagree by ` +
        `${Math.abs(moge - geo).toFixed(1)}°, more than the worker accepts, so the camera calibration is an estimate.`
      );
    }
    return "GeoCalib and MoGe-2 disagree on the field of view by more than the worker accepts, so the camera calibration is an estimate.";
  }
  return `${p.message.charAt(0).toUpperCase()}${p.message.slice(1)}${/[.!?]$/.test(p.message) ? "" : "."}`;
}

export function explainRun(diagnostics: RunDiagnostics, scale: "estimated" | "calibrated"): Explanation {
  const problems = diagnostics.status === "failed" ? diagnostics.errors : diagnostics.warnings;
  const reasons = problems.map((p) => ({ code: p.code, stage: p.stage, text: describeProblem(p) }));
  const camera = diagnostics.warnings.some((w) => w.stage === "camera");

  const headline =
    diagnostics.status === "failed"
      ? "The reconstruction failed."
      : diagnostics.status === "succeeded"
        ? "Reconstruction completed."
        : camera
          ? "Reconstruction completed with estimated camera calibration."
          : "Reconstruction completed with warnings.";

  const calibrated =
    scale !== "calibrated"
      ? null
      : camera
        ? "Scale is calibrated to your measurement. Calibration fixes the room's size, not its proportions: those still rest on the estimated field of view."
        : "Scale is calibrated to your measurement.";

  return {
    status: diagnostics.status,
    headline,
    reasons,
    calibrated,
    action: diagnostics.status !== "failed" && scale === "estimated" ? CALIBRATE : null,
  };
}
