import type { Vec3 } from "@/scene/model/types";
import type { PlaneObservation, ViewRecord } from "./intermediate";

/** Small, dependency-free geometry for the compiler. Pure functions only. */

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

export const DEG = 180 / Math.PI;

/** The rigid transform camera-opencv → capture, read from the view's column-major 4×4. */
export interface CameraPose {
  /** Row-major 3×3: capture = R · camera + t. */
  r: readonly [Vec3, Vec3, Vec3];
  t: Vec3;
}

export function cameraPose(view: ViewRecord): CameraPose {
  const m = view.cameraToCapture;
  // Column-major: element (row i, col j) is m[j * 4 + i].
  const row = (i: number): Vec3 => [m[i], m[4 + i], m[8 + i]];
  return { r: [row(0), row(1), row(2)], t: [m[12], m[13], m[14]] };
}

export function toCapture(pose: CameraPose, p: Vec3): Vec3 {
  return add([dot(pose.r[0], p), dot(pose.r[1], p), dot(pose.r[2], p)], pose.t);
}

/** Rotate a camera-frame direction into the capture frame. */
export function directionToCapture(pose: CameraPose, v: Vec3): Vec3 {
  return [dot(pose.r[0], v), dot(pose.r[1], v), dot(pose.r[2], v)];
}

/** Rᵀ·v: a capture-frame direction in the camera frame. */
export function directionToCamera(pose: CameraPose, v: Vec3): Vec3 {
  const [a, b, c] = pose.r;
  return [a[0] * v[0] + b[0] * v[1] + c[0] * v[2], a[1] * v[0] + b[1] * v[1] + c[1] * v[2], a[2] * v[0] + b[2] * v[1] + c[2] * v[2]];
}

/**
 * Where the ray through a pixel meets a plane, in the capture frame.
 * Pixel coordinates are continuous, in the canonical image, with pixel
 * centres at +0.5. Returns null when the ray runs parallel to the plane or
 * meets it behind the camera.
 */
export function pixelOnPlane(view: ViewRecord, plane: PlaneObservation, pixel: readonly [number, number]): Vec3 | null {
  const { fx, fy, cx, cy } = view.camera.intrinsics;
  const ray: Vec3 = [(pixel[0] - cx.value) / fx.value, (pixel[1] - cy.value) / fy.value, 1];
  const pose = cameraPose(view);
  // n·(R·x + t) + d = 0  →  (Rᵀn)·x + (n·t + d) = 0
  const n = directionToCamera(pose, plane.normal);
  const d = dot(plane.normal, pose.t) + plane.offset;
  const denom = dot(n, ray);
  if (Math.abs(denom) < 1e-9) return null;
  const lambda = -d / denom;
  if (!(lambda > 0)) return null;
  return toCapture(pose, scale(ray, lambda));
}

/** Rotation about +Y by -yaw, as the compiler applies it: (x, z) at angle yaw lands on +X. */
export function yawRotate([x, y, z]: Vec3, yawDeg: number): Vec3 {
  const a = yawDeg / DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c + z * s, y, -x * s + z * c];
}

/** Round to a grid so float noise can never create a diff. -0 becomes 0. */
export const round = (value: number, step = 0.001) => {
  const r = Math.round(value / step) * step;
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  const fixed = Number(r.toFixed(digits));
  return fixed === 0 ? 0 : fixed;
};
