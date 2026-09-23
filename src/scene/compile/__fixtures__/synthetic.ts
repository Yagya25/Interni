import type { Vec3 } from "@/scene/model/types";
import { dot, sub, yawRotate } from "../frame";
import type { InstanceObservation, PlaneObservation, Quantity, ReconstructionIntermediate } from "../intermediate";

/**
 * A synthetic ReconstructionIntermediate for compiler tests: an exactly
 * known box room, as the worker would describe it. Test scaffolding only:
 * it exists to check the compiler's arithmetic against a known truth, and
 * is never shown or shipped as a reconstruction.
 */
export interface SyntheticRoom {
  /** True room, in room axes, with the camera at x = z = 0: [xMin, xMax, zMin, zMax]. */
  box: readonly [number, number, number, number];
  height: number;
  cameraHeight: number;
  /** The depth model's scale error: every length in the intermediate is truth × this. */
  scaleError: number;
  /** How far the room's axes are turned from the capture frame, degrees. */
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  sides: { left: boolean; far: boolean; right: boolean };
  ceiling: boolean;
}

export const DEFAULT_ROOM: SyntheticRoom = {
  box: [-1.8, 2.2, -4.6, 0.9],
  height: 2.7,
  cameraHeight: 1.45,
  scaleError: 0.9,
  yawDeg: 25,
  pitchDeg: -12,
  rollDeg: 0.4,
  sides: { left: true, far: true, right: false },
  ceiling: true,
};

export const WIDTH = 1600;
export const HEIGHT = 1200;
export const FOCAL = 1100;

const q = <T>(value: T, basis: Quantity["basis"] = "estimated"): Quantity<T> => ({
  value,
  basis,
  sigma: null,
  interval: null,
  confidence: null,
  sources: ["synthetic"],
});

/** Room axes → capture frame (the inverse of the compiler's yaw). */
const toCapture = (room: SyntheticRoom, p: Vec3): Vec3 => {
  const [x, y, z] = yawRotate(p, -room.yawDeg);
  return [x * room.scaleError, y * room.scaleError, z * room.scaleError];
};
const dirToCapture = (room: SyntheticRoom, v: Vec3): Vec3 => yawRotate(v, -room.yawDeg);

/** Camera axes (right, down, forward) in the capture frame. */
export function cameraAxes(room: SyntheticRoom): [Vec3, Vec3, Vec3] {
  const p = (room.pitchDeg * Math.PI) / 180;
  const r = (room.rollDeg * Math.PI) / 180;
  const forward: Vec3 = [0, Math.sin(p), -Math.cos(p)];
  const right0: Vec3 = [1, 0, 0];
  const down0: Vec3 = [
    forward[1] * right0[2] - forward[2] * right0[1],
    forward[2] * right0[0] - forward[0] * right0[2],
    forward[0] * right0[1] - forward[1] * right0[0],
  ];
  const right: Vec3 = [0, 1, 2].map((i) => right0[i] * Math.cos(r) + down0[i] * Math.sin(r)) as unknown as Vec3;
  const down: Vec3 = [0, 1, 2].map((i) => -right0[i] * Math.sin(r) + down0[i] * Math.cos(r)) as unknown as Vec3;
  return [right, down, forward];
}

/** Project a capture-frame point into the canonical image. */
export function project(room: SyntheticRoom, p: Vec3): [number, number] {
  const [right, down, forward] = cameraAxes(room);
  const rel = sub(p, [0, room.cameraHeight * room.scaleError, 0]);
  const zc = dot(rel, forward);
  return [FOCAL * (dot(rel, right) / zc) + WIDTH / 2, FOCAL * (dot(rel, down) / zc) + HEIGHT / 2];
}

/** A point on a true (room-axes, true-scale) surface, in the capture frame. */
export const truePoint = (room: SyntheticRoom, p: Vec3) => toCapture(room, p);

function plane(room: SyntheticRoom, id: string, role: PlaneObservation["role"], nRoom: Vec3, onRoom: Vec3,
  uRange: [number, number], heightRange: [number, number]): PlaneObservation {
  const normal = dirToCapture(room, nRoom);
  const point = toCapture(room, onRoom);
  const up: Vec3 = [0, 1, 0];
  const u: Vec3 = role === "wall"
    ? [up[1] * normal[2] - up[2] * normal[1], up[2] * normal[0] - up[0] * normal[2], up[0] * normal[1] - up[1] * normal[0]]
    : [1, 0, 0];
  const v: Vec3 = role === "wall" ? up : [0, 0, 1];
  const offset = -dot(normal, point);
  const camera: Vec3 = [0, room.cameraHeight * room.scaleError, 0];
  return {
    id,
    role,
    label: 1,
    normal,
    offset,
    inliers: 50000,
    supportFraction: 0.2,
    visibleArea: 4,
    rmsResidual: 0.01,
    distanceFromCamera: dot(normal, camera) + offset,
    centroid: point,
    visibleExtent: { axes: { u, v }, min: [uRange[0], 0], max: [uRange[1], 1] },
    heightRange,
    pixelBox: [0, 0, WIDTH, HEIGHT],
    touchesImageBorder: { left: false, right: false, top: false, bottom: false },
    method: "synthetic",
  };
}

/**
 * Synthetic instance observations in the default room (scale error 1), as
 * the worker would record them for known pieces. Returns room-axis truths
 * alongside so tests can check placement against them.
 */
export function syntheticInstances(room: SyntheticRoom): InstanceObservation[] {
  const cap = (p: Vec3) => toCapture(room, p);
  const dir = (v: Vec3) => dirToCapture(room, v);
  const none = { left: false, right: false, top: false, bottom: false };
  const planeU = (planeNormalRoom: Vec3, a: Vec3, b: Vec3): [number, number] => {
    const n = dirToCapture(room, planeNormalRoom);
    const u: Vec3 = [n[2], 0, -n[0]];
    const ua = dot(cap(a), u);
    const ub = dot(cap(b), u);
    return [Math.min(ua, ub), Math.max(ua, ub)];
  };
  const base = (id: string, label: string, score: number, maskScore = 0.97): InstanceObservation => ({
    id,
    labels: [{ label, score }],
    score,
    scoreKind: "synthetic",
    promptGroup: 0,
    box: [0, 0, 10, 10],
    mask: { index: 0, score: maskScore, scoreKind: "synthetic" },
    maskArea: 1000,
    touchesImageBorder: none,
    apparentColour: { srgbHex: "#807060", pixels: 1000, clippedFraction: 0 },
    wallContact: [],
    wallProjection: null,
    geometry: "ok",
  });
  const floorThing = (inst: InstanceObservation, center: Vec3, size: Vec3, heights: [number, number], front: Vec3 | null, surfaces: number[] = []): InstanceObservation => ({
    ...inst,
    points: { count: 5000, centroid: cap(center), depthMedian: 3, depthRange: [2.5, 3.5], rejectedAsOutliers: 0 },
    heightRange: heights,
    // Room axis X is at capture azimuth yawDeg.
    visibleBox: { center: cap(center), size, yawDeg: room.yawDeg, axisSource: "manhattan" },
    yawCandidates: [],
    frontNormal: front ? dir(front) : null,
    horizontalSurfaces: surfaces.map((height) => ({ height, shareOfUpFacing: 0.5 })),
    contact: { floorGap: heights[0] },
  });
  const [x0, , z0] = room.box;
  return [
    // A sofa against the left wall; only its front 0.6 m is seen.
    floorThing(base("instance-0", "sofa", 0.7), [x0 + 0.6, 0.45, -2.5], [0.6, 0.8, 2.0], [0.05, 0.85], [1, 0, 0], [0.45]),
    floorThing(base("instance-1", "coffee table", 0.48), [-0.2, 0.2, -2.5], [0.6, 0.42, 1.1], [0.0, 0.42], [0, 0, 1], [0.42]),
    floorThing({ ...base("instance-2", "potted plant", 0.5), labels: [{ label: "potted plant", score: 0.5 }] }, [-0.2, 0.7, -2.3], [0.3, 0.52, 0.3], [0.43, 0.95], null),
    {
      ...floorThing(base("instance-3", "tv", 0.47), [0.1, 1.25, z0 + 0.03], [1.2, 0.7, 0.04], [0.9, 1.6], [0, 0, 1]),
      wallContact: [{ planeId: "plane-2", pointFraction: 1, ringFraction: 0.9, gap: 0.01 }],
      wallProjection: { planeId: "plane-2", u: planeU([0, 0, 1], [-0.5, 0, z0], [0.7, 0, z0]), v: [0.9, 1.6], method: "synthetic" },
    },
    {
      ...base("instance-4", "picture frame", 0.43),
      geometry: "too-few-points",
      wallContact: [{ planeId: "plane-3", pointFraction: 1, ringFraction: 0.95, gap: 0 }],
      wallProjection: { planeId: "plane-3", u: planeU([1, 0, 0], [x0, 0, -2.8], [x0, 0, -2.2]), v: [1.4, 1.9], method: "synthetic" },
    },
    {
      ...base("instance-5", "window", 0.4),
      geometry: "too-few-points",
      wallContact: [{ planeId: "plane-2", pointFraction: 0, ringFraction: 0.6, gap: -2 }],
      wallProjection: { planeId: "plane-2", u: planeU([0, 0, 1], [1.0, 0, z0], [1.9, 0, z0]), v: [0.9, 2.2], method: "synthetic" },
    },
    // Seen through the window: set in no wall of this room.
    { ...base("instance-6", "window", 0.35), geometry: "too-few-points", wallContact: [{ planeId: "plane-2", pointFraction: 0, ringFraction: 0, gap: -4 }] },
    floorThing(base("instance-7", "chair", 0.27), [1.0, 0.45, -1.5], [0.45, 0.9, 0.5], [0, 0.9], [0, 0, 1]),
    { ...base("instance-8", "ceiling fan", 0.8), geometry: "too-few-points" },
    floorThing(base("instance-9", "sofa", 0.5, 0.6), [1.5, 0.4, -3], [0.9, 0.8, 1.8], [0.05, 0.85], [0, 0, 1]),
  ];
}

export function syntheticIntermediate(overrides: Partial<SyntheticRoom> = {}, instances?: (room: SyntheticRoom) => InstanceObservation[]): ReconstructionIntermediate {
  const room = { ...DEFAULT_ROOM, ...overrides };
  const [x0, x1, z0] = room.box;
  const k = room.scaleError;
  const h = room.height;
  const planes: PlaneObservation[] = [plane(room, "plane-0", "floor", [0, 1, 0], [0.2, 0, -2], [x0 * k, x1 * k], [0, 0])];
  if (room.ceiling) planes.push(plane(room, "plane-1", "ceiling", [0, -1, 0], [0.2, h, -2.5], [x0 * k, x1 * k], [h * k, h * k]));
  // Walls: centroids inside their visible part; u-ranges in intermediate (scaled) metres along each wall.
  const wallU = (a: Vec3, b: Vec3, n: Vec3): [number, number] => {
    const normal = dirToCapture(room, n);
    const u: Vec3 = [normal[2], 0, -normal[0]];
    const ua = dot(toCapture(room, a), u);
    const ub = dot(toCapture(room, b), u);
    return [Math.min(ua, ub), Math.max(ua, ub)];
  };
  if (room.sides.far) {
    planes.push(plane(room, "plane-2", "wall", [0, 0, 1], [0.3, 1.3, z0], wallU([x0 + 0.4, 0, z0], [x1 - 0.1, 0, z0], [0, 0, 1]), [0.1 * k, 2.6 * k]));
  }
  if (room.sides.left) {
    planes.push(plane(room, "plane-3", "wall", [1, 0, 0], [x0, 1.2, -2.5], wallU([x0, 0, -1.2], [x0, 0, z0], [1, 0, 0]), [0.2 * k, 2.6 * k]));
  }
  if (room.sides.right) {
    planes.push(plane(room, "plane-4", "wall", [-1, 0, 0], [x1, 1.2, -3.0], wallU([x1, 0, -2.0], [x1, 0, z0], [-1, 0, 0]), [0.2 * k, 2.6 * k]));
  }
  // Visible floor: a quadrilateral that stops short of any wall not seen.
  const floorRoom: Vec3[] = [
    [x0 + 0.05, 0, -1.3],
    [x1 - 0.35, 0, -1.3],
    [x1 - 0.35, 0, z0 + 0.05],
    [x0 + 0.05, 0, z0 + 0.05],
  ];
  const [right, down, forward] = cameraAxes(room);
  const m = [...right, 0, ...down, 0, ...forward, 0, 0, room.cameraHeight * k, 0, 1];
  const fov = 2 * Math.atan(HEIGHT / 2 / FOCAL) * (180 / Math.PI);

  return {
    schemaVersion: 1,
    jobId: "synthetic-room",
    createdAt: "2026-09-22T00:00:00Z",
    pipeline: {
      version: "synthetic",
      worker: { version: "synthetic", codeSha256: "0".repeat(64) },
      models: [],
      runtime: {},
      settings: {},
      seeds: {},
    },
    source: {
      photographId: "synthetic",
      inputSha256: "0".repeat(64),
      inputBytes: 0,
      inputFormat: "jpeg",
      orientationApplied: 1,
      originalWidth: WIDTH,
      originalHeight: HEIGHT,
      width: WIDTH,
      height: HEIGHT,
      downscale: 1,
      exif: {},
      canonical: { key: "source.jpg", format: "jpeg", width: WIDTH, height: HEIGHT, encoding: "", sha256: "" },
      stats: {},
    },
    views: [
      {
        viewId: "view-0",
        photographId: "synthetic",
        camera: {
          model: "pinhole",
          intrinsics: { fx: q(FOCAL), fy: q(FOCAL), cx: q(WIDTH / 2, "default"), cy: q(HEIGHT / 2, "default") },
          distortion: { model: "none" },
          upCam: q<Vec3>([0, -1, 0]),
          roll: q(room.rollDeg),
          pitch: q(room.pitchDeg),
          pitchUp: q(room.pitchDeg),
          verticalFov: q(fov),
          candidates: { geocalib: { verticalFov: q(fov), focalPx: q(FOCAL) }, moge: { verticalFov: q(fov) }, exif: null },
          fovSource: "geocalib",
          agreement: { geocalibVsMoge: 0, geocalibVsExif: null, mogeVsExif: null },
        },
        geometry: {
          depth: { key: "depth.png", format: "png16-mm", width: WIDTH, height: HEIGHT, encoding: "", sha256: "" },
          normals: { key: "normals.png", format: "png8-normal", width: WIDTH, height: HEIGHT, encoding: "", sha256: "" },
          validMask: { key: "valid-mask.png", format: "png8-mask", width: WIDTH, height: HEIGHT, encoding: "", sha256: "" },
          depthPreview: { key: "depth-preview.png", format: "png8-preview", width: WIDTH, height: HEIGHT, encoding: "", sha256: "" },
          planeLabels: { key: "planes.png", format: "png8-labels", width: WIDTH, height: HEIGHT, encoding: "", sha256: "" },
          planesPreview: { key: "planes-preview.png", format: "png8-preview", width: WIDTH, height: HEIGHT, encoding: "", sha256: "" },
          scale: { basis: "estimated", source: "synthetic", logSigma: null, note: "" },
          stats: { validFraction: 1, depthRange: [0.5, 6], depthMedian: 3 },
          fovUsedDeg: fov,
          mogeVerticalFovDeg: fov,
        },
        cameraToCapture: m,
        stages: {
          intake: { status: "succeeded" },
          camera: { status: "succeeded" },
          geometry: { status: "succeeded" },
          segmentation: { status: "skipped" },
          layout: { status: "succeeded" },
          objects: { status: "skipped" },
          appearance: { status: "skipped" },
        },
      },
    ],
    world: {
      frame: "capture",
      up: { source: "floor-plane", gravityAgreementDeg: 0.5 },
      gravityAgreementDeg: 0.5,
      manhattan: { yawDeg: room.yawDeg, alignedAreaFraction: 0.9, note: "" },
      cameraHeight: q(room.cameraHeight * k),
      planes,
      floorOutline: { points: floorRoom.map((p) => { const c = toCapture(room, p); return [c[0], c[2]] as const; }), basis: "estimated", note: "" },
      layout: { settings: {}, stride: 1, counts: {} },
      openings: [],
      instances: instances ? instances(room) : [],
      appearance: [],
      light: null,
      roomType: [],
    },
    diagnostics: {
      status: "succeeded",
      warnings: [],
      errors: [],
      stages: {
        intake: { status: "succeeded" },
        camera: { status: "succeeded" },
        geometry: { status: "succeeded" },
        segmentation: { status: "skipped" },
        layout: { status: "succeeded" },
        objects: { status: "skipped" },
        appearance: { status: "skipped" },
      },
      timingsMs: {},
      peakGpuMemoryByStageMb: {},
      peakGpuMemoryMb: null,
      memoryNote: "",
    },
  };
}
