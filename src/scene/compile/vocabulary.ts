import type { MaterialClass, ObjectCategory } from "@/scene/model/types";

/**
 * Vocabulary: what a detector phrase may become in a Scene, and the typical
 * sizes used where the photograph cannot show a dimension.
 * ================================================================
 * Versioned data, not logic. A phrase maps to an object category the
 * renderer can draw, to an opening, or explicitly to nothing ("seen, not
 * modelled"), which is reported rather than forced into a wrong category.
 *
 * Size priors are [p10, p50, p90] in metres, from common furniture
 * standards. They are used only for what was not seen (usually depth, since
 * the camera sees a piece's front) and are labelled `inferred` wherever
 * they land. Every value is provisional until the evaluation set measures it.
 */

export type Range = readonly [p10: number, p50: number, p90: number];

export interface CategoryPrior {
  category: ObjectCategory;
  form?: string;
  width: Range;
  height: Range;
  depth: Range;
  /** The slot the photo's apparent colour is applied to. */
  primarySlot: string;
  secondarySlots: readonly string[];
  materialClass: MaterialClass;
  /**
   * floor: stands on the floor (or, for small things, on another piece).
   * wall: hangs flat on a wall, measured on the wall plane.
   * tv: on a wall when it is on one, otherwise stood on something.
   */
  mount: "floor" | "floor-or-object" | "wall" | "tv";
  /** Faces away from a wall it stands against (a sofa, a console), rather than towards the camera. */
  backToWall: boolean;
}

export type Meaning =
  | { kind: "object"; prior: CategoryPrior }
  | { kind: "lamp" } // decided by height: see compileObjects
  | { kind: "opening"; opening: "window" | "door"; glazed: boolean }
  | { kind: "unmodelled"; reason: string };

const p = (prior: CategoryPrior): Meaning => ({ kind: "object", prior });

export const PRIORS_BY_CATEGORY = {
  sofa: { category: "sofa", form: "track-arm", width: [1.6, 2.1, 2.6], height: [0.75, 0.85, 0.95], depth: [0.8, 0.9, 1.0], primarySlot: "upholstery", secondarySlots: ["legs"], materialClass: "fabric", mount: "floor", backToWall: true },
  armchair: { category: "armchair", width: [0.7, 0.85, 1.0], height: [0.75, 0.85, 1.0], depth: [0.7, 0.85, 0.95], primarySlot: "upholstery", secondarySlots: ["legs"], materialClass: "fabric", mount: "floor", backToWall: false },
  chair: { category: "chair", width: [0.4, 0.46, 0.55], height: [0.8, 0.9, 1.0], depth: [0.45, 0.52, 0.6], primarySlot: "frame", secondarySlots: ["seat"], materialClass: "wood", mount: "floor", backToWall: false },
  ottoman: { category: "ottoman", form: "round", width: [0.4, 0.5, 0.7], height: [0.35, 0.42, 0.5], depth: [0.4, 0.5, 0.7], primarySlot: "cover", secondarySlots: [], materialClass: "fabric", mount: "floor", backToWall: false },
  bench: { category: "bench", width: [0.9, 1.2, 1.6], height: [0.4, 0.45, 0.5], depth: [0.3, 0.38, 0.45], primarySlot: "top", secondarySlots: [], materialClass: "wood", mount: "floor", backToWall: false },
  "coffee-table": { category: "coffee-table", form: "slab", width: [0.8, 1.1, 1.4], height: [0.35, 0.42, 0.5], depth: [0.45, 0.6, 0.8], primarySlot: "top", secondarySlots: ["legs"], materialClass: "wood", mount: "floor", backToWall: false },
  "side-table": { category: "side-table", form: "block", width: [0.35, 0.45, 0.6], height: [0.45, 0.55, 0.65], depth: [0.35, 0.45, 0.6], primarySlot: "top", secondarySlots: [], materialClass: "wood", mount: "floor", backToWall: false },
  "dining-table": { category: "dining-table", width: [1.2, 1.6, 2.2], height: [0.72, 0.75, 0.78], depth: [0.75, 0.9, 1.0], primarySlot: "top", secondarySlots: ["legs"], materialClass: "wood", mount: "floor", backToWall: false },
  desk: { category: "desk", width: [1.0, 1.3, 1.6], height: [0.72, 0.75, 0.78], depth: [0.5, 0.65, 0.8], primarySlot: "top", secondarySlots: ["legs"], materialClass: "wood", mount: "floor", backToWall: true },
  cabinet: { category: "cabinet", width: [0.6, 0.9, 1.6], height: [0.8, 1.2, 2.0], depth: [0.35, 0.45, 0.6], primarySlot: "body", secondarySlots: [], materialClass: "wood", mount: "floor", backToWall: true },
  "media-console": { category: "media-console", width: [1.2, 1.6, 2.2], height: [0.4, 0.55, 0.75], depth: [0.35, 0.42, 0.5], primarySlot: "body", secondarySlots: ["legs"], materialClass: "wood", mount: "floor", backToWall: true },
  bed: { category: "bed", width: [1.2, 1.6, 2.0], height: [0.4, 0.6, 1.1], depth: [1.9, 2.05, 2.2], primarySlot: "bedding", secondarySlots: ["frame"], materialClass: "fabric", mount: "floor", backToWall: true },
  television: { category: "television", width: [0.8, 1.2, 1.6], height: [0.5, 0.7, 0.95], depth: [0.03, 0.06, 0.1], primarySlot: "screen", secondarySlots: ["frame"], materialClass: "glass", mount: "tv", backToWall: true },
  bookshelf: { category: "bookshelf", width: [0.4, 0.8, 1.2], height: [0.9, 1.8, 2.2], depth: [0.25, 0.32, 0.4], primarySlot: "body", secondarySlots: [], materialClass: "wood", mount: "floor", backToWall: true },
  plant: { category: "plant", width: [0.2, 0.4, 0.8], height: [0.3, 0.8, 1.8], depth: [0.2, 0.4, 0.8], primarySlot: "foliage", secondarySlots: ["pot", "stem"], materialClass: "plant", mount: "floor-or-object", backToWall: false },
  "floor-lamp": { category: "floor-lamp", form: "tripod", width: [0.3, 0.4, 0.5], height: [1.4, 1.6, 1.8], depth: [0.3, 0.4, 0.5], primarySlot: "shade", secondarySlots: ["stand"], materialClass: "fabric", mount: "floor", backToWall: false },
  curtain: { category: "curtain", width: [0.4, 1.0, 2.0], height: [2.0, 2.4, 2.8], depth: [0.05, 0.1, 0.15], primarySlot: "fabric", secondarySlots: [], materialClass: "fabric", mount: "wall", backToWall: true },
  artwork: { category: "artwork", width: [0.2, 0.5, 1.2], height: [0.2, 0.6, 1.0], depth: [0.02, 0.03, 0.05], primarySlot: "surface", secondarySlots: ["frame"], materialClass: "paper", mount: "wall", backToWall: true },
  rug: { category: "rug", form: "rect", width: [1.2, 2.0, 3.0], height: [0.008, 0.012, 0.02], depth: [0.8, 1.4, 2.0], primarySlot: "pile", secondarySlots: [], materialClass: "fabric", mount: "floor", backToWall: false },
} as const satisfies Record<string, CategoryPrior>;

export const VOCABULARY = {
  version: "vocabulary-0.1",
  phrases: {
    sofa: p(PRIORS_BY_CATEGORY.sofa),
    armchair: p(PRIORS_BY_CATEGORY.armchair),
    chair: p(PRIORS_BY_CATEGORY.chair),
    ottoman: p(PRIORS_BY_CATEGORY.ottoman),
    bench: p(PRIORS_BY_CATEGORY.bench),
    stool: { kind: "unmodelled", reason: "this version has no stool; an ottoman is not a stool" },
    "coffee table": p(PRIORS_BY_CATEGORY["coffee-table"]),
    "side table": p(PRIORS_BY_CATEGORY["side-table"]),
    "dining table": p(PRIORS_BY_CATEGORY["dining-table"]),
    desk: p(PRIORS_BY_CATEGORY.desk),
    cabinet: p(PRIORS_BY_CATEGORY.cabinet),
    "tv stand": p(PRIORS_BY_CATEGORY["media-console"]),
    bed: p(PRIORS_BY_CATEGORY.bed),
    tv: p(PRIORS_BY_CATEGORY.television),
    shelf: p(PRIORS_BY_CATEGORY.bookshelf),
    "potted plant": p(PRIORS_BY_CATEGORY.plant),
    "floor lamp": { kind: "lamp" },
    "table lamp": { kind: "lamp" },
    curtain: p(PRIORS_BY_CATEGORY.curtain),
    "picture frame": p(PRIORS_BY_CATEGORY.artwork),
    rug: p(PRIORS_BY_CATEGORY.rug),
    window: { kind: "opening", opening: "window", glazed: true },
    "glass door": { kind: "opening", opening: "door", glazed: true },
    door: { kind: "opening", opening: "door", glazed: false },
    "ceiling fan": { kind: "unmodelled", reason: "this version has no ceiling fan" },
    "wall clock": { kind: "unmodelled", reason: "this version has no clock" },
  } as Readonly<Record<string, Meaning>>,
} as const;

/**
 * Thresholds on the models' raw scores. They are not probabilities, so these
 * are provisional bars, not confidence levels: set at the detector's usual
 * working point and to be replaced by calibrated bands (§15.3) once the
 * evaluation set exists.
 */
export const OBJECT_RULES = {
  version: "object-rules-0.1",
  /** Grounding DINO box score needed to emit an object. */
  emitScore: 0.3,
  /** Below emitScore but at least this: reported as a candidate, not emitted. */
  candidateScore: 0.25,
  /** SAM 2.1 predicted IoU needed to trust the mask's geometry. */
  maskScore: 0.8,
  /** A lamp whose top is at least this high is a floor lamp. */
  floorLampTop: 1.2,
  /** A piece whose back is this close to a wall stands against it. */
  againstWall: 0.35,
  /** Something whose base is this far off the floor is not standing on it. */
  offFloor: 0.2,
  /** A thing sits on a piece whose top is within this of its base. */
  restsOnTolerance: 0.15,
  /** A TV this far up a wall, mostly on it, hangs on it. */
  tvOnWallFraction: 0.5,
  tvOnWallBase: 0.3,
  /** An opening must be surrounded by its wall this much to be one. */
  openingRing: 0.3,
} as const;
