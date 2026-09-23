import type { Material } from "@/scene/model/types";

/**
 * The priors table: every number the compiler uses that the photograph did
 * not supply. Versioned data, not logic, so a change to an assumption is a
 * change of version that the report records. Each value is used only where
 * evidence is missing, and is labelled `default` wherever it lands.
 *
 * All values are provisional until the evaluation set measures them.
 */
export const PRIORS = {
  version: "priors-0.1",
  /** A single photograph cannot see into a wall. */
  wallThickness: 0.12,
  /** Used only when neither a ceiling nor any wall top supports a higher value. */
  defaultCeilingHeight: 2.5,
  /** The least the room extends behind the camera, which never sees that way. */
  clearanceBehindCamera: 0.5,
  /** The least the room extends beside the camera when that side was not seen. */
  clearanceBesideCamera: 0.3,
  /** Walls within this of an axis are snapped to it; beyond it they are reported, not forced. */
  axisSnapDeg: 12,
  /** How far evidence may lie beyond an observed wall before the report flags it. */
  evidenceBeyondWallTolerance: 0.15,
  /** Roll above this is reported, because the Scene camera cannot represent it. */
  rollReportDeg: 1,
  /** The orbit target is kept this far inside the room. */
  targetInset: 0.4,
} as const;

/**
 * Finishes for surfaces whose material has not been estimated (milestone 1
 * does not estimate materials). The Scene contract requires a material and a
 * class; these say plainly in their names that nothing was read.
 */
export const UNESTIMATED_MATERIALS: readonly Material[] = [
  {
    id: "unestimated-floor",
    class: "paint",
    name: "Floor — finish not estimated",
    color: "#b9b4ab",
    roughness: 0.9,
    metalness: 0,
    pattern: "none",
  },
  {
    id: "unestimated-wall",
    class: "paint",
    name: "Wall — finish not estimated",
    color: "#dedad3",
    roughness: 0.92,
    metalness: 0,
    pattern: "none",
  },
  {
    id: "unestimated-ceiling",
    class: "paint",
    name: "Ceiling — finish not estimated",
    color: "#ebe8e3",
    roughness: 0.95,
    metalness: 0,
    pattern: "none",
  },
];
