import type { MaterialClass } from "@/scene/model/types";

/**
 * Everything the stage can show, as plain numbers.
 *
 * The stage never animates itself. An external driver (the landing page's
 * scroll timeline today, an editor tomorrow) mutates this object and calls
 * `stage.invalidate()`. Because the rendered frame is a pure function of
 * these values, any scroll position (forwards, backwards, or jumped to)
 * produces a coherent image.
 */
export interface ViewState {
  camera: {
    px: number;
    py: number;
    pz: number;
    tx: number;
    ty: number;
    tz: number;
    /** Vertical field of view in degrees. */
    fov: number;
  };
  /** 1 = composed inside the hero frame like a print, 0 = full bleed. */
  frame: number;

  // Understanding layers ----------------------------------------------------
  /** Depth map overlay strength. */
  depth: number;
  /** Distance from the capture camera the depth map has propagated to (m). */
  depthFront: number;
  /** 1 = neutral architectural model; materials are hidden. */
  clay: number;
  /** Edge linework on architecture. */
  edges: number;
  /** Exploded-view separation of walls, ceiling and openings. */
  explode: number;
  /** Fade architecture or objects towards paper to direct attention. */
  dimArchitecture: number;
  dimObjects: number;
  /** Objects lift away from what supports them. */
  separate: number;
  /** 3D bounding-box brackets around objects. */
  boxes: number;
  /** Per-material-class reveal from clay back to material, 0..1. */
  reveal: Record<RevealGroup, number>;
  /** Room corner occlusion. */
  occlusion: number;

  // Light --------------------------------------------------------------------
  /** 0 = midday, 0.5 = warm afternoon, 1 = evening. */
  time: number;
  /** Sun direction guides. */
  rays: number;

  // Editing ------------------------------------------------------------------
  editMove: number;
  editReplace: number;
  editMaterial: number;

  // Space --------------------------------------------------------------------
  /** 0 = interior photograph, 1 = cutaway model on the ground plane. */
  cutaway: number;
  relations: number;
  dimensions: number;

  // Redesign -----------------------------------------------------------------
  /** Objects that persist into the variant travel to their new placement. */
  arrange: number;
  /** Position of the redesign front sweeping through the room, 0..1. */
  wave: number;
  waveLine: number;
}

/** Material classes that are revealed together. */
export type RevealGroup = "wood" | "fabric" | "stone" | "glass" | "metal" | "leather" | "paint" | "other";

export const revealGroupOf = (materialClass: MaterialClass): RevealGroup => {
  switch (materialClass) {
    case "wood":
    case "fabric":
    case "stone":
    case "glass":
    case "metal":
    case "leather":
    case "paint":
      return materialClass;
    default:
      return "other";
  }
};

export const revealGroups: readonly RevealGroup[] = [
  "wood",
  "fabric",
  "stone",
  "glass",
  "metal",
  "leather",
  "paint",
  "other",
];

export function createViewState(camera: ViewState["camera"]): ViewState {
  return {
    camera: { ...camera },
    frame: 1,
    depth: 0,
    depthFront: 0,
    clay: 0,
    edges: 0,
    explode: 0,
    dimArchitecture: 0,
    dimObjects: 0,
    separate: 0,
    boxes: 0,
    reveal: { wood: 0, fabric: 0, stone: 0, glass: 0, metal: 0, leather: 0, paint: 0, other: 0 },
    occlusion: 1,
    time: 0.18,
    rays: 0,
    editMove: 0,
    editReplace: 0,
    editMaterial: 0,
    cutaway: 0,
    relations: 0,
    dimensions: 0,
    arrange: 0,
    wave: 0,
    waveLine: 0,
  };
}
