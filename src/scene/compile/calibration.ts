import { findById } from "@/scene/model/queries";
import { length, pixelOnPlane, sub } from "./frame";
import type { ReconstructionIntermediate } from "./intermediate";

/**
 * Calibration by a real measurement.
 *
 * One photograph fixes a room's shape far better than its size: to the
 * depth model, a room and the same room 10% larger look alike. That makes
 * the size error one number shared by every length, so one real length the
 * person knows ("this door is 0.9 m wide") fixes all of them at once, by a
 * single factor, without running any model again.
 *
 * One factor corrects scale, not shape. A wrong field of view stretches
 * depth relative to width, and a measurement across the photo cannot fix
 * that; the residuals of several references are how it shows.
 */
export type CalibrationReference =
  /**
   * Two points the person marked on the photograph, both on one fitted plane,
   * and the real distance between them. `a` and `b` are canonical-image
   * pixel coordinates, pixel centres at +0.5.
   */
  | {
      kind: "on-plane";
      planeId: string;
      a: readonly [number, number];
      b: readonly [number, number];
      metres: number;
      label?: string;
    }
  /** Floor to ceiling. Only possible when the ceiling was seen. */
  | { kind: "room-height"; metres: number; label?: string };

export interface CalibrationFile {
  schemaVersion: 1;
  references: readonly CalibrationReference[];
}

export interface ScaleSolution {
  factor: number;
  basis: "estimated" | "calibrated";
  accepted: readonly { reference: CalibrationReference; estimate: number; ratio: number; residual: number }[];
  rejected: readonly { reference: CalibrationReference; reason: string }[];
}

const MIN_METRES = 0.05;
const MAX_METRES = 50;

/** The uncalibrated length a reference measures, from the intermediate alone. */
export function estimateOf(intermediate: ReconstructionIntermediate, reference: CalibrationReference): number | string {
  const { planes } = intermediate.world;
  if (reference.kind === "room-height") {
    const ceiling = planes.find((p) => p.role === "ceiling");
    return ceiling ? ceiling.centroid[1] : "the ceiling was not seen, so its height cannot be a reference";
  }
  const plane = findById(planes, reference.planeId);
  if (!plane) return `there is no plane ${reference.planeId}`;
  const view = intermediate.views[0];
  const a = pixelOnPlane(view, plane, reference.a);
  const b = pixelOnPlane(view, plane, reference.b);
  if (!a || !b) return "a marked point does not look onto that plane";
  const e = length(sub(a, b));
  return e > 1e-6 ? e : "the two marked points coincide";
}

/**
 * The scale factor all lengths are multiplied by. Without references it is
 * 1 and the basis stays `estimated`. With several, their log-ratios are
 * averaged with equal weight: the uncertainty of each estimate is not yet
 * measured, so none is weighted above another.
 */
export function solveScale(
  intermediate: ReconstructionIntermediate,
  references: readonly CalibrationReference[],
): ScaleSolution {
  const accepted: { reference: CalibrationReference; estimate: number; ratio: number }[] = [];
  const rejected: { reference: CalibrationReference; reason: string }[] = [];
  for (const reference of references) {
    if (!Number.isFinite(reference.metres) || reference.metres < MIN_METRES || reference.metres > MAX_METRES) {
      rejected.push({ reference, reason: `a measurement must be between ${MIN_METRES} and ${MAX_METRES} m` });
      continue;
    }
    const estimate = estimateOf(intermediate, reference);
    if (typeof estimate === "string") rejected.push({ reference, reason: estimate });
    else accepted.push({ reference, estimate, ratio: reference.metres / estimate });
  }
  if (!accepted.length) return { factor: 1, basis: "estimated", accepted: [], rejected };
  const logs = accepted.map((a) => Math.log(a.ratio));
  const mean = logs.reduce((sum, v) => sum + v, 0) / logs.length;
  return {
    factor: Math.exp(mean),
    basis: "calibrated",
    accepted: accepted.map((a, i) => ({ ...a, residual: logs[i] - mean })),
    rejected,
  };
}

/** Read a calibration file, refusing anything that isn't one. */
export function parseCalibration(json: unknown): CalibrationFile | string {
  if (typeof json !== "object" || json === null) return "calibration must be an object";
  const file = json as Partial<CalibrationFile>;
  if (file.schemaVersion !== 1) return `unsupported calibration schemaVersion ${String(file.schemaVersion)}`;
  if (!Array.isArray(file.references)) return "calibration.references must be an array";
  for (const [i, r] of file.references.entries()) {
    const ok =
      r && typeof r.metres === "number" &&
      (r.kind === "room-height" ||
        (r.kind === "on-plane" && typeof r.planeId === "string" && isPoint(r.a) && isPoint(r.b)));
    if (!ok) return `calibration.references[${i}] is not a valid reference`;
  }
  return file as CalibrationFile;
}

const isPoint = (p: unknown) =>
  Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v));
