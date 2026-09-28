"use client";

import { createContext, useContext } from "react";
import type { CalibrationReference } from "@/scene/compile/calibration";
import type { CompileReport, SceneEvidence } from "@/scene/compile/evidence";
import type { ReconstructionIntermediate } from "@/scene/compile/intermediate";

/**
 * Where a reconstructed room came from, for the parts of the workspace that
 * have to say so: the person's own photograph, and whether the sizes drawn
 * are the depth model's estimate or calibrated to a real measurement.
 * Absent for the demonstration room, which is not from anyone's photograph.
 */
export interface WorkspaceSource {
  /** URL of the photograph the room was reconstructed from. */
  photograph: string;
  scale: "estimated" | "calibrated";
  /** How each reconstructed value was known, keyed by Scene id. */
  evidence?: SceneEvidence;
  /** Why a calibration the run has could not be used, when it could not; the scale then stays estimated. */
  calibrationProblem?: string | null;
  /** What the compiler decided, and what the worker observed: read by the evidence panel. */
  report?: CompileReport;
  intermediate?: ReconstructionIntermediate;
  /** The worker's plane label map, for marking a calibration distance. */
  planeMap?: string;
  /**
   * Save these references as the run's calibration and recompile the room
   * from its reconstruction with them. An empty list returns it to its
   * estimated scale. Absent where a room cannot be calibrated.
   */
  calibrate?: (references: readonly CalibrationReference[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

const SourceContext = createContext<WorkspaceSource | null>(null);

export const SourceProvider = SourceContext.Provider;

export const useWorkspaceSource = () => useContext(SourceContext);
