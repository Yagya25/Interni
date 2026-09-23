import type { Vec3 } from "@/scene/model/types";

/**
 * ReconstructionIntermediate v1
 * =============================
 * What the GPU worker observed in one photograph, exactly as it wrote it
 * (`reconstruction/` in ~/datum-recon, schema module `schema.py`). It is
 * immutable: scenes are recompiled from it, and the GPU is never run again
 * to change a decision.
 *
 * Frames
 * - camera-opencv: x right, y down, z forward, as the models emit it.
 * - capture: +Y up (the fitted floor normal), floor at y = 0, origin on the
 *   floor directly below the camera, camera looking towards -Z.
 *
 * All lengths are the depth model's metric estimate before calibration.
 * Plane normals point towards the camera: n·x + d = 0, n·camera + d > 0.
 */

/** How a value is known. Ordered from strongest to weakest. */
export type Basis =
  | "measured" // read off pixels or metadata by a known procedure, or entered by the person
  | "calibrated" // an estimate rescaled by a measured reference
  | "estimated" // produced by a model from visible pixels
  | "inferred" // not visible; completed from constraints
  | "default"; // nothing to go on; a stated default

export interface Quantity<T = number> {
  value: T;
  basis: Basis;
  /** What the producing model reports as its own 1σ, in the value's unit. Not validated. */
  sigma: number | null;
  /** Central 80% interval, once measured against an evaluation set. */
  interval: readonly [number, number] | null;
  /**
   * Null in v1 throughout: a 0..1 confidence must be calibrated against a
   * tape-measured evaluation set, and there is none yet.
   */
  confidence: number | null;
  sources: readonly string[];
  note?: string;
}

export interface Problem {
  code: string;
  stage: string;
  severity: "warning" | "error";
  message: string;
  detail?: Readonly<Record<string, unknown>>;
}

export interface ArtefactRef {
  key: string;
  format: string;
  width: number;
  height: number;
  encoding: string;
  sha256: string;
}

export type StageId = "intake" | "camera" | "geometry" | "segmentation" | "layout" | "objects" | "appearance";
export interface StageOutcome {
  status: "succeeded" | "degraded" | "failed" | "skipped";
  problem?: string;
}

export type PlaneRole = "floor" | "ceiling" | "wall" | "other-horizontal" | "other-vertical";

export interface PlaneObservation {
  id: string;
  role: PlaneRole;
  /** Value of this plane in the `planeLabels` artefact. */
  label: number;
  normal: Vec3;
  offset: number;
  inliers: number;
  supportFraction: number;
  /** Visible area in m², before calibration. */
  visibleArea: number;
  rmsResidual: number;
  distanceFromCamera: number;
  /** Area-weighted centre of the visible part, capture frame. */
  centroid: Vec3;
  /** Extent of the visible part along the plane's in-plane axes: a lower bound on its true extent. */
  visibleExtent: {
    axes: { u: Vec3; v: Vec3 };
    min: readonly [number, number];
    max: readonly [number, number];
  };
  heightRange: readonly [number, number];
  pixelBox: readonly [number, number, number, number];
  touchesImageBorder: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  method: string;
  directionDeg?: number;
}

/**
 * One segmented thing the detector found, measured in the capture frame.
 * Scores are the models' raw outputs, not calibrated probabilities; every
 * extent is of the *visible* part, a lower bound on the thing itself.
 */
export interface InstanceObservation {
  id: string;
  /** Every vocabulary phrase that matched, best first. */
  labels: readonly { label: string; score: number }[];
  score: number;
  scoreKind: string;
  promptGroup: number;
  box: readonly [number, number, number, number];
  mask: { index: number; score: number; scoreKind: string };
  maskArea: number;
  touchesImageBorder: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  apparentColour: { srgbHex: string | null; pixels: number; clippedFraction: number | null };
  wallContact: readonly { planeId: string; pointFraction: number; ringFraction: number; gap: number | null }[];
  /** Where the mask lies on its host wall, by ray–plane intersection: u along the wall's u axis, v = height. */
  wallProjection: { planeId: string; u: readonly [number, number]; v: readonly [number, number]; method: string } | null;
  geometry: "ok" | "too-few-points";
  points?: {
    count: number;
    centroid: Vec3;
    depthMedian: number;
    depthRange: readonly [number, number];
    rejectedAsOutliers: number;
  };
  heightRange?: readonly [number, number];
  /** Gravity-aligned box of the visible points. Axis 0 at `yawDeg` (azimuth atan2(z, x)), axis 1 up. */
  visibleBox?: { center: Vec3; size: Vec3; yawDeg: number; axisSource: "manhattan" | "pca" };
  yawCandidates?: readonly { yawDeg: number; source: string; footprintArea: number }[];
  /** Mean horizontal normal of its visible vertical faces: which way the side the camera saw points. */
  frontNormal?: Vec3 | null;
  /** Heights of its own up-facing surfaces (a seat, a tabletop), each with its share of its up-facing points. */
  horizontalSurfaces?: readonly { height: number; shareOfUpFacing: number }[];
  contact?: { floorGap: number };
}

/**
 * Apparent colour of a region: the per-channel median, in linear RGB, of its
 * well-exposed pixels. It is the surface under this photo's light, after the
 * camera's white balance, not the surface's own colour.
 */
export interface ColourStats {
  pixels: number;
  wellExposedPixels: number;
  clippedFraction: number;
  darkFraction: number;
  linear: Vec3;
  srgbHex: string;
  luminance: number;
  /** Median ΔE (CIE76) of the pixels from the median colour. */
  spreadDeltaE: number;
  /** At most three colours, largest share first. */
  palette: readonly { srgbHex: string; linear: Vec3; share: number }[];
}

export type RegionTarget =
  | { kind: "plane"; planeId: string; role: PlaneRole }
  | { kind: "instance"; instanceId: string; phrase: string }
  | { kind: "part"; instanceId: string; phrase: string; part: string; method: string };

/** Where the floor would mirror a wall-mounted instance, and what the photo shows there. */
export interface FloorReflection {
  instanceId: string;
  reflectedPixels: number;
  /** Median brightness inside the mirrored region over beside it, at the same image rows. */
  contrast: number;
  insideLuminance: number;
  besideLuminance: number;
  /** How well the region matches the instance's own image, warped by the mirror and blurred. */
  match: readonly { blurPx: number; ncc: number }[];
  bestBlurPx: number | null;
  bestBlurDeg: number | null;
}

export interface PlaneTexture {
  method: string;
  resolutionM: number;
  maxDistanceM: number;
  analysedAreaM2: number;
  specularExcludedFraction: number;
  axes: readonly { name: string; direction: Vec3; period: number | null; strength: number | null; harmonic: number | null }[];
}

/** S6: how one region looks, and what SigLIP 2 scores it as. */
export interface AppearanceObservation {
  regionId: string;
  target: RegionTarget;
  colour: ColourStats;
  /** Raw zero-shot logits over every MaterialClass, best first. Not probabilities. */
  materialClass?: { subject: string; scores: readonly { class: string; logit: number }[]; promptsVersion: string; scoreKind: string };
  texture?: PlaneTexture;
  reflections?: readonly FloorReflection[];
  colourOutsideReflections?: ColourStats;
}

export interface LightColourObservation {
  /** The colour scaled to unit luminance, linear RGB. */
  linearUnitLuminance: Vec3;
  srgbHex: string;
  xy: readonly [number, number];
  cctK: number;
  cctMethod: string;
}

/** S6: what the photograph shows about its light. Relative to the photo's own, unknown, exposure. */
export interface LightObservation {
  version: string;
  illuminant: {
    greyWorld: LightColourObservation & { pixels: number; note: string };
    ceiling: (LightColourObservation & { pixels: number; note: string }) | null;
  };
  shading: {
    method: string;
    regions: readonly { regionId: string; pixels: number; normalSpread: number; a: number; b: Vec3; directionality: number; r2: number }[];
    combined: { towardsLight: Vec3; directionality: number; agreement: number; regions: number; weighting: string } | null;
  };
  gradient: {
    method: string;
    planes: readonly string[];
    gradientPerMetre: Vec3;
    horizontalTowardsBrighter: Vec3 | null;
    horizontalPerMetre: number;
    rmseLog: number;
    note: string;
  } | null;
  openings: readonly {
    instanceId: string;
    phrase: string;
    part: string;
    pixels: number;
    medianLuminance: number;
    p90Luminance: number;
    clippedFraction: number;
    toInterior: number;
    apparent: LightColourObservation;
  }[];
  sunPatches: { method: string; planes: readonly { planeId: string; patchPixels: number; fraction: number; largestPixels: number }[]; fraction: number };
  emission: readonly {
    instanceId: string;
    phrase: string;
    p99ToInterior: number;
    clippedFraction: number;
    shade?: { medianLuminance: number; surroundMedianLuminance: number; toSurround: number; clippedFraction: number };
  }[];
  exposure: { interiorMedianLuminance: number; interiorP99Luminance: number; clippedFraction: number; darkFraction: number; note: string };
}

export interface CameraObservation {
  model: "pinhole";
  /** Pixels of the canonical image (`source.width` × `source.height`). */
  intrinsics: { fx: Quantity; fy: Quantity; cx: Quantity; cy: Quantity };
  distortion: { model: "none" };
  upCam: Quantity<Vec3>;
  roll: Quantity;
  pitch: Quantity;
  pitchUp: Quantity;
  verticalFov: Quantity;
  candidates: {
    geocalib: { verticalFov: Quantity; focalPx: Quantity };
    moge: { verticalFov: Quantity };
    exif: { focal35mm: Quantity; verticalFov: Quantity } | null;
  };
  fovSource: "geocalib" | "moge";
  agreement: { geocalibVsMoge: number; geocalibVsExif: number | null; mogeVsExif: number | null };
}

export interface ModelRecord {
  id: string;
  role: string;
  repo: string;
  codeRevision: string;
  codeLicence: string;
  weights: { source: string; revision: string; file: string; sha256: string; licence: string };
  attribution: string | null;
}

export interface SourceRecord {
  photographId: string;
  inputSha256: string;
  inputBytes: number;
  inputFormat: string;
  orientationApplied: number;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  downscale: number;
  exif: { focal35mm?: number; make?: string; model?: string };
  canonical: ArtefactRef;
  stats: Readonly<Record<string, number>>;
}

export interface ViewRecord {
  viewId: string;
  photographId: string;
  camera: CameraObservation;
  geometry: {
    depth: ArtefactRef;
    normals: ArtefactRef;
    validMask: ArtefactRef;
    depthPreview: ArtefactRef;
    planeLabels: ArtefactRef;
    planesPreview: ArtefactRef;
    scale: { basis: "estimated"; source: string; logSigma: number | null; note: string };
    stats: { validFraction: number; depthRange: readonly [number, number]; depthMedian: number };
    fovUsedDeg: number;
    mogeVerticalFovDeg: number;
  };
  /** 4×4, column-major: camera-opencv → capture. */
  cameraToCapture: readonly number[];
  stages: Readonly<Record<StageId, StageOutcome>>;
}

export interface WorldRecord {
  frame: "capture";
  up: { source: string; gravityAgreementDeg: number };
  gravityAgreementDeg: number;
  manhattan: { yawDeg: number; alignedAreaFraction: number; note: string } | null;
  cameraHeight: Quantity;
  planes: readonly PlaneObservation[];
  floorOutline: { points: readonly (readonly [number, number])[]; basis: Basis; note: string } | null;
  layout: { settings: Readonly<Record<string, unknown>>; stride: number; counts: Readonly<Record<string, unknown>> };
  openings: readonly unknown[];
  instances: readonly InstanceObservation[];
  /** Empty when S6 did not run. */
  appearance: readonly AppearanceObservation[];
  light: LightObservation | null;
  roomType: readonly unknown[];
}

export interface Diagnostics {
  status: "succeeded" | "degraded" | "failed";
  warnings: readonly Problem[];
  errors: readonly Problem[];
  stages: Readonly<Record<StageId, StageOutcome>>;
  timingsMs: Readonly<Record<string, number>>;
  peakGpuMemoryByStageMb: Readonly<Record<string, number>>;
  peakGpuMemoryMb: number | null;
  memoryNote: string;
}

export interface ReconstructionIntermediate {
  schemaVersion: 1;
  jobId: string;
  /** The compiler's only clock. */
  createdAt: string;
  pipeline: {
    version: string;
    worker: { version: string; codeSha256: string };
    models: readonly ModelRecord[];
    runtime: Readonly<Record<string, unknown>>;
    settings: Readonly<Record<string, unknown>>;
    seeds: Readonly<Record<string, unknown>>;
  };
  source: SourceRecord;
  views: readonly ViewRecord[];
  world: WorldRecord;
  diagnostics: Diagnostics;
}

/** A run that failed before it had anything to show. It still says why. */
export interface FailedRun {
  schemaVersion: 1;
  jobId: string;
  createdAt: string;
  diagnostics: Diagnostics;
}

export type ParsedRun =
  | { kind: "run"; intermediate: ReconstructionIntermediate }
  | { kind: "failed"; run: FailedRun }
  | { kind: "invalid"; reason: string };

/**
 * Check what the worker wrote before anything is built from it. Only the
 * shape the compiler relies on is checked, and a mismatch names the field.
 * An unknown schema version is refused rather than guessed at.
 */
export function parseIntermediate(json: unknown): ParsedRun {
  try {
    const root = record(json, "intermediate");
    if (root.schemaVersion !== 1) {
      return { kind: "invalid", reason: `unsupported schemaVersion ${String(root.schemaVersion)}` };
    }
    text(root.jobId, "jobId");
    text(root.createdAt, "createdAt");
    const diagnostics = record(root.diagnostics, "diagnostics");
    list(diagnostics.errors, "diagnostics.errors");
    list(diagnostics.warnings, "diagnostics.warnings");
    if (diagnostics.status === "failed") return { kind: "failed", run: json as FailedRun };

    const pipeline = record(root.pipeline, "pipeline");
    text(pipeline.version, "pipeline.version");
    list(pipeline.models, "pipeline.models");

    const source = record(root.source, "source");
    text(source.photographId, "source.photographId");
    positive(source.width, "source.width");
    positive(source.height, "source.height");

    const views = list(root.views, "views");
    if (views.length !== 1) return { kind: "invalid", reason: `expected exactly one view, found ${views.length}` };
    const view = record(views[0], "views[0]");
    const camera = record(view.camera, "views[0].camera");
    const intrinsics = record(camera.intrinsics, "camera.intrinsics");
    for (const key of ["fx", "fy", "cx", "cy"]) positive(record(intrinsics[key], `intrinsics.${key}`).value, `intrinsics.${key}`);
    const m = list(view.cameraToCapture, "cameraToCapture");
    if (m.length !== 16 || !m.every(isFiniteNumber)) return { kind: "invalid", reason: "cameraToCapture must be 16 numbers" };

    const world = record(root.world, "world");
    if (world.frame !== "capture") return { kind: "invalid", reason: `unknown world frame ${String(world.frame)}` };
    positive(record(world.cameraHeight, "world.cameraHeight").value, "world.cameraHeight");
    for (const [i, raw] of list(world.planes, "world.planes").entries()) {
      const plane = record(raw, `planes[${i}]`);
      text(plane.id, `planes[${i}].id`);
      text(plane.role, `planes[${i}].role`);
      vec3(plane.normal, `planes[${i}].normal`);
      vec3(plane.centroid, `planes[${i}].centroid`);
      finite(plane.offset, `planes[${i}].offset`);
      finite(plane.visibleArea, `planes[${i}].visibleArea`);
      const extent = record(plane.visibleExtent, `planes[${i}].visibleExtent`);
      const axes = record(extent.axes, `planes[${i}].visibleExtent.axes`);
      vec3(axes.u, `planes[${i}].visibleExtent.axes.u`);
      pair(extent.min, `planes[${i}].visibleExtent.min`);
      pair(extent.max, `planes[${i}].visibleExtent.max`);
      pair(plane.heightRange, `planes[${i}].heightRange`);
    }
    for (const [i, raw] of list(world.instances ?? [], "world.instances").entries()) {
      const at = `instances[${i}]`;
      const inst = record(raw, at);
      text(inst.id, `${at}.id`);
      finite(inst.score, `${at}.score`);
      const labels = list(inst.labels, `${at}.labels`);
      if (!labels.length) throw new Error(`${at}.labels must not be empty`);
      labels.forEach((l, j) => {
        const label = record(l, `${at}.labels[${j}]`);
        text(label.label, `${at}.labels[${j}].label`);
        finite(label.score, `${at}.labels[${j}].score`);
      });
      finite(record(inst.mask, `${at}.mask`).score, `${at}.mask.score`);
      list(inst.wallContact, `${at}.wallContact`);
      if (inst.geometry !== "ok" && inst.geometry !== "too-few-points") throw new Error(`${at}.geometry is not a known state`);
      if (inst.geometry === "ok") {
        const box = record(inst.visibleBox, `${at}.visibleBox`);
        vec3(box.center, `${at}.visibleBox.center`);
        vec3(box.size, `${at}.visibleBox.size`);
        finite(box.yawDeg, `${at}.visibleBox.yawDeg`);
        pair(inst.heightRange, `${at}.heightRange`);
      }
      if (inst.wallProjection != null) {
        const p = record(inst.wallProjection, `${at}.wallProjection`);
        text(p.planeId, `${at}.wallProjection.planeId`);
        pair(p.u, `${at}.wallProjection.u`);
        pair(p.v, `${at}.wallProjection.v`);
      }
    }
    for (const [i, raw] of list(world.appearance ?? [], "world.appearance").entries()) {
      appearance(raw, `appearance[${i}]`);
    }
    if (world.light != null) light(world.light, "world.light");
    return { kind: "run", intermediate: json as ReconstructionIntermediate };
  } catch (error) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// S6

/** The Scene's own material classes: a score for anything else is not ours to read. */
const MATERIAL_CLASSES = new Set(["wood", "fabric", "stone", "glass", "metal", "paint", "ceramic", "paper", "leather", "plant"]);
const HEX = /^#[0-9a-f]{6}$/;

function colour(v: unknown, at: string) {
  const c = record(v, at);
  positive(c.pixels, `${at}.pixels`);
  vec3(c.linear, `${at}.linear`);
  if (typeof c.srgbHex !== "string" || !HEX.test(c.srgbHex)) throw new Error(`${at}.srgbHex must be #rrggbb`);
  for (const key of ["clippedFraction", "darkFraction", "luminance", "spreadDeltaE"]) finite(c[key], `${at}.${key}`);
  for (const [j, raw] of list(c.palette, `${at}.palette`).entries()) {
    const p = record(raw, `${at}.palette[${j}]`);
    if (typeof p.srgbHex !== "string" || !HEX.test(p.srgbHex)) throw new Error(`${at}.palette[${j}].srgbHex must be #rrggbb`);
    finite(p.share, `${at}.palette[${j}].share`);
  }
}

function appearance(v: unknown, at: string) {
  const a = record(v, at);
  text(a.regionId, `${at}.regionId`);
  const target = record(a.target, `${at}.target`);
  if (target.kind === "plane") text(target.planeId, `${at}.target.planeId`);
  else if (target.kind === "instance" || target.kind === "part") text(target.instanceId, `${at}.target.instanceId`);
  else throw new Error(`${at}.target.kind is not a known region kind`);
  colour(a.colour, `${at}.colour`);
  if (a.colourOutsideReflections != null) colour(a.colourOutsideReflections, `${at}.colourOutsideReflections`);
  if (a.materialClass != null) {
    const m = record(a.materialClass, `${at}.materialClass`);
    const scores = list(m.scores, `${at}.materialClass.scores`);
    if (!scores.length) throw new Error(`${at}.materialClass.scores must not be empty`);
    scores.forEach((s, j) => {
      const score = record(s, `${at}.materialClass.scores[${j}]`);
      if (typeof score.class !== "string" || !MATERIAL_CLASSES.has(score.class)) {
        throw new Error(`${at}.materialClass.scores[${j}].class is not a Scene material class`);
      }
      finite(score.logit, `${at}.materialClass.scores[${j}].logit`);
    });
  }
  for (const [j, raw] of list(a.reflections ?? [], `${at}.reflections`).entries()) {
    const r = record(raw, `${at}.reflections[${j}]`);
    text(r.instanceId, `${at}.reflections[${j}].instanceId`);
    finite(r.contrast, `${at}.reflections[${j}].contrast`);
  }
  if (a.texture != null) {
    const t = record(a.texture, `${at}.texture`);
    for (const [j, raw] of list(t.axes, `${at}.texture.axes`).entries()) {
      const axis = record(raw, `${at}.texture.axes[${j}]`);
      if (axis.period !== null) finite(axis.period, `${at}.texture.axes[${j}].period`);
    }
  }
}

function lightColour(v: unknown, at: string) {
  const c = record(v, at);
  vec3(c.linearUnitLuminance, `${at}.linearUnitLuminance`);
  pair(c.xy, `${at}.xy`);
  finite(c.cctK, `${at}.cctK`);
  if (typeof c.srgbHex !== "string" || !HEX.test(c.srgbHex)) throw new Error(`${at}.srgbHex must be #rrggbb`);
}

function light(v: unknown, at: string) {
  const l = record(v, at);
  text(l.version, `${at}.version`);
  const illuminant = record(l.illuminant, `${at}.illuminant`);
  lightColour(illuminant.greyWorld, `${at}.illuminant.greyWorld`);
  if (illuminant.ceiling != null) lightColour(illuminant.ceiling, `${at}.illuminant.ceiling`);
  const shading = record(l.shading, `${at}.shading`);
  list(shading.regions, `${at}.shading.regions`);
  if (shading.combined != null) {
    const c = record(shading.combined, `${at}.shading.combined`);
    vec3(c.towardsLight, `${at}.shading.combined.towardsLight`);
    finite(c.agreement, `${at}.shading.combined.agreement`);
  }
  for (const [j, raw] of list(l.openings, `${at}.openings`).entries()) {
    const o = record(raw, `${at}.openings[${j}]`);
    text(o.instanceId, `${at}.openings[${j}].instanceId`);
    finite(o.toInterior, `${at}.openings[${j}].toInterior`);
    lightColour(o.apparent, `${at}.openings[${j}].apparent`);
  }
  finite(record(l.sunPatches, `${at}.sunPatches`).fraction, `${at}.sunPatches.fraction`);
  for (const [j, raw] of list(l.emission, `${at}.emission`).entries()) {
    const e = record(raw, `${at}.emission[${j}]`);
    text(e.instanceId, `${at}.emission[${j}].instanceId`);
    if (e.shade != null) finite(record(e.shade, `${at}.emission[${j}].shade`).toSurround, `${at}.emission[${j}].shade.toSurround`);
  }
  finite(record(l.exposure, `${at}.exposure`).interiorMedianLuminance, `${at}.exposure.interiorMedianLuminance`);
}

// ---------------------------------------------------------------------------

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function record(v: unknown, at: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${at} must be an object`);
  return v as Record<string, unknown>;
}
function list(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${at} must be an array`);
  return v;
}
function text(v: unknown, at: string) {
  if (typeof v !== "string" || !v) throw new Error(`${at} must be a non-empty string`);
}
function finite(v: unknown, at: string) {
  if (!isFiniteNumber(v)) throw new Error(`${at} must be a finite number`);
}
function positive(v: unknown, at: string) {
  if (!isFiniteNumber(v) || v <= 0) throw new Error(`${at} must be a positive number`);
}
function vec3(v: unknown, at: string) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isFiniteNumber)) throw new Error(`${at} must be 3 numbers`);
}
function pair(v: unknown, at: string) {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(isFiniteNumber)) throw new Error(`${at} must be 2 numbers`);
}
