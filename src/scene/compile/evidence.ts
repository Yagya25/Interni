import type { Id, Scene } from "@/scene/model/types";
import type { CalibrationReference } from "./calibration";
import type { Basis, Problem, Quantity } from "./intermediate";
import type { LightingReport } from "./lighting";
import type { MaterialsReport } from "./materials";
import type { ObjectsReport } from "./objects";

/**
 * How every number in a compiled Scene was known.
 *
 * The Scene contract has no room for uncertainty, and is not changed to
 * make some: this sidecar sits beside it, keyed by the Scene's own ids.
 * Nothing that already reads a Scene needs to read it.
 */
export interface SceneEvidence {
  schemaVersion: 1;
  sceneId: Id;
  scale: ScaleEvidence;
  entities: Readonly<Record<Id, EntityEvidence>>;
}

export interface ScaleEvidence {
  factor: number;
  basis: "estimated" | "calibrated";
  /** σ of ln(scale). Null until measured: uncalibrated scale error is unknown. */
  logSigma: number | null;
  references: readonly CalibrationReference[];
  /** ln(reference ratio) − ln(factor), per accepted reference. */
  residuals: readonly number[];
}

export interface EntityEvidence {
  kind: "room" | "camera" | "surface" | "object" | "opening" | "material" | "light" | "relationship";
  /** Whether the thing is there at all, and how that is known. */
  presence: { basis: Basis };
  /** Keyed by field path in the Scene entity, e.g. "height", "start", "position.1". */
  fields: Readonly<Record<string, Quantity<unknown>>>;
  /** Observation ids in the intermediate this entity was built from. */
  observations: readonly string[];
  /** Other readings the models offered, with their raw scores (not probabilities). */
  alternatives?: readonly { field: string; value: string; score: number }[];
  /** Plain-language account, for people. */
  notes: readonly string[];
}

export type Side = "left" | "far" | "right" | "behind";

export interface CompileReport {
  compilerVersion: string;
  priorsVersion: string;
  jobId: string;
  pipelineVersion: string;
  /** Capture frame → scene frame: yaw about +Y, then scale, then translation on XZ. */
  frame: { yawDeg: number; scale: number; translation: readonly [number, number] };
  sides: Readonly<Record<Side, { status: "observed" | "inferred" | "omitted"; planeId: string | null; position: number; basis: Basis }>>;
  dimensions: {
    width: Quantity;
    depth: Quantity;
    height: Quantity;
  };
  planes: {
    used: readonly { id: string; role: string; as: string }[];
    ignored: readonly { id: string; role: string; reason: string }[];
  };
  /** What became of every detected instance. Null when objects were not compiled. */
  objects: ObjectsReport | null;
  /** Which material every surface and slot got, and how its class was decided. */
  materials: MaterialsReport;
  /** The light read from the photograph, and how each part of it was used. */
  lighting: LightingReport;
  relationships: { rulesVersion: string; count: number };
  problems: readonly Problem[];
}

export type CompileResult =
  | { ok: true; scene: Scene; evidence: SceneEvidence; report: CompileReport }
  | { ok: false; problem: Problem };
