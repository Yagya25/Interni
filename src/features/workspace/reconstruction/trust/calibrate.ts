import { estimateOf, solveScale, type CalibrationReference, type ScaleSolution } from "@/scene/compile/calibration";
import type { CompileReport } from "@/scene/compile/evidence";
import type { PlaneObservation, ReconstructionIntermediate } from "@/scene/compile/intermediate";

/**
 * Turning what a person marks on their photograph into a calibration
 * reference, in the format the compiler already reads (`calibration.json`
 * schema 1, the same one `python -m reconstruction.calibrate` writes).
 *
 * Nothing here scales anything. It resolves marks to the plane the worker
 * fitted under them, measures the uncalibrated length between them with the
 * compiler's own `estimateOf`, and previews the factor with the compiler's
 * own `solveScale`. Applying it is a recompile, done elsewhere.
 */

/** The worker's `planes.png`: one byte per canonical-image pixel, the `label` of the plane there, 0 for none. */
export interface PlaneLabelMap {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** The same bounds `solveScale` enforces. */
export const MIN_METRES = 0.05;
export const MAX_METRES = 50;
/** References that disagree by more than this are reported by the compiler, too. */
export const DISAGREEMENT = 0.05;

export type Pixel = readonly [number, number];

/** Which fitted plane is under a canonical-image pixel (pixel centres at +0.5), if any. */
export function planeAt(intermediate: ReconstructionIntermediate, map: PlaneLabelMap, pixel: Pixel): PlaneObservation | null {
  const x = Math.floor(pixel[0]);
  const y = Math.floor(pixel[1]);
  if (!(x >= 0 && y >= 0 && x < map.width && y < map.height)) return null;
  const label = map.data[y * map.width + x];
  if (!label) return null;
  return intermediate.world.planes.find((p) => p.label === label) ?? null;
}

/** Whether a label map belongs to this run's canonical image. */
export const mapFits = (intermediate: ReconstructionIntermediate, map: PlaneLabelMap) =>
  map.width === intermediate.source.width && map.height === intermediate.source.height && map.data.length === map.width * map.height;

/** What a plane is, in the room's words: "the floor", "the left wall", "a vertical surface". */
export function planeName(plane: PlaneObservation, report: CompileReport | null): string {
  const used = report?.planes.used.find((u) => u.id === plane.id)?.as;
  if (used === "floor" || plane.role === "floor") return "the floor";
  if (used === "ceiling" || plane.role === "ceiling") return "the ceiling";
  if (used?.startsWith("wall-")) return `the ${used.slice(5)} wall`;
  if (plane.role === "wall") return "a wall";
  return plane.role === "other-horizontal" ? "a horizontal surface" : "a vertical surface";
}

export function checkMetres(metres: number): string | null {
  if (!Number.isFinite(metres)) return "Enter the real length in metres.";
  if (metres < MIN_METRES || metres > MAX_METRES) return `The real length must be between ${MIN_METRES} and ${MAX_METRES} m.`;
  return null;
}

export type Marked =
  | { ok: true; plane: PlaneObservation; estimate: number }
  | { ok: false; reason: string };

/** Two marks, checked: both on one fitted plane, and apart. `estimate` is the uncalibrated length between them. */
export function measureMarks(intermediate: ReconstructionIntermediate, map: PlaneLabelMap, a: Pixel, b: Pixel): Marked {
  if (!mapFits(intermediate, map)) return { ok: false, reason: "The plane map does not match this photograph." };
  const pa = planeAt(intermediate, map, a);
  const pb = planeAt(intermediate, map, b);
  if (!pa || !pb) return { ok: false, reason: "Both points must be on a surface the reconstruction fitted (shown tinted)." };
  if (pa.id !== pb.id) return { ok: false, reason: "Both points must be on the same surface: a distance along one wall, the floor, or one flat face." };
  const estimate = estimateOf(intermediate, { kind: "on-plane", planeId: pa.id, a, b, metres: 1 });
  if (typeof estimate === "string") return { ok: false, reason: `That distance can't be used: ${estimate}.` };
  return { ok: true, plane: pa, estimate };
}

const px = (p: Pixel): [number, number] => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];

export function onPlaneReference(plane: PlaneObservation, a: Pixel, b: Pixel, metres: number, label?: string): CalibrationReference {
  return { kind: "on-plane", planeId: plane.id, a: px(a), b: px(b), metres, ...(label?.trim() ? { label: label.trim() } : {}) };
}

export function roomHeightReference(metres: number, label?: string): CalibrationReference {
  return { kind: "room-height", metres, ...(label?.trim() ? { label: label.trim() } : {}) };
}

/** The reconstruction's own, uncalibrated reading of what a reference measures. */
export const uncalibratedLength = (intermediate: ReconstructionIntermediate, reference: CalibrationReference) =>
  estimateOf(intermediate, reference);

export interface Preview {
  solution: ScaleSolution;
  /** How much every length changes, as a signed percentage. */
  changePercent: number;
  /** The references disagree with each other by more than the compiler accepts quietly. */
  disagree: boolean;
}

/** What applying these references would do, computed exactly as the compiler will. */
export function previewCalibration(intermediate: ReconstructionIntermediate, references: readonly CalibrationReference[]): Preview {
  const solution = solveScale(intermediate, references);
  // The compiler's own test, so the preview warns exactly when the compiled room will.
  const disagree = solution.accepted.some((a) => Math.abs(a.residual) > DISAGREEMENT);
  return { solution, changePercent: (solution.factor - 1) * 100, disagree };
}
