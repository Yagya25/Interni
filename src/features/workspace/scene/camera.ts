import { clamp, degToRad } from "@/lib/math";
import { objectCenter, roomBounds, type Bounds } from "@/scene/model/queries";
import type { Scene, SceneObject, Vec3 } from "@/scene/model/types";
import type { ViewState } from "@/scene/render/viewState";

/**
 * The workspace camera.
 *
 * It writes into the stage's `ViewState` — the same object the landing
 * page's timeline writes into — and never touches the renderer's camera
 * directly, so there is still exactly one description of where the view is.
 *
 * The pose is spherical around a target inside the room: an architect
 * walking round a model, not a free-flying game camera. The limits below
 * are what keeps it feeling that way — you cannot end up inside a wall, or
 * under the floor, or staring at the back of the house.
 */

export interface Pose {
  target: Vec3;
  /** Azimuth in the XZ plane, measured from +Z towards +X. */
  theta: number;
  /** Polar angle from +Y. Small is overhead, π/2 is level. */
  phi: number;
  radius: number;
}

const PHI_MIN = 0.12;
const PHI_MAX = 1.62;
const RADIUS_MIN = 0.9;
/** How far round the room the view may swing from where the photograph was taken. */
const THETA_SPAN = 2.0;
/** Distance the target keeps from the walls, floor and ceiling. */
const TARGET_INSET = 0.35;

const ORBIT_PER_PIXEL = 0.0062;
const DOLLY_PER_NOTCH = 1.0015;
/** How fast the view catches up with the hand, per second. */
const DAMPING = 14;

export class CameraRig {
  readonly bounds: Bounds;
  private readonly centreTheta: number;
  private readonly radiusMax: number;
  private readonly roomHeight: number;

  private current: Pose;
  private desired: Pose;
  private frame = 0;
  private last = 0;
  private instant: boolean;
  private disposed = false;

  constructor(
    private readonly view: ViewState,
    scene: Scene,
    private readonly onChange: () => void,
    options: { reducedMotion?: boolean } = {},
  ) {
    this.bounds = roomBounds(scene);
    this.roomHeight = scene.room.height;
    const span = Math.hypot(
      this.bounds.max[0] - this.bounds.min[0],
      this.bounds.max[2] - this.bounds.min[2],
    );
    this.radiusMax = span * 1.6;
    this.instant = options.reducedMotion ?? false;

    const capture = poseBetween(scene.camera.position, scene.camera.target);
    this.centreTheta = capture.theta;
    this.current = this.constrain(capture);
    this.desired = this.current;
    this.write();
  }

  /** Whether the view moves under a gesture or jumps straight there. */
  setReducedMotion(reduced: boolean) {
    this.instant = reduced;
  }

  // -------------------------------------------------------------------------
  // Gestures. Deltas are in pixels; the caller owns the pointer.

  orbit(dx: number, dy: number) {
    this.moveTo({
      ...this.desired,
      theta: this.desired.theta - dx * ORBIT_PER_PIXEL,
      phi: this.desired.phi - dy * ORBIT_PER_PIXEL,
    });
  }

  /** Slide the target across the screen plane, dragging the view with it. */
  pan(dx: number, dy: number, viewportHeight: number) {
    const { theta, phi, radius, target } = this.desired;
    const perPixel = (2 * radius * Math.tan(degToRad(this.view.camera.fov) / 2)) / Math.max(1, viewportHeight);
    // Screen right and screen up, in world space, for the current pose.
    const right: Vec3 = [Math.cos(theta), 0, -Math.sin(theta)];
    const up: Vec3 = [-Math.cos(phi) * Math.sin(theta), Math.sin(phi), -Math.cos(phi) * Math.cos(theta)];
    this.moveTo({
      ...this.desired,
      target: [
        target[0] - (right[0] * dx - up[0] * dy) * perPixel,
        target[1] - (right[1] * dx - up[1] * dy) * perPixel,
        target[2] - (right[2] * dx - up[2] * dy) * perPixel,
      ],
    });
  }

  /** `notches` is a wheel delta or a pinch distance change, in pixels. */
  dolly(notches: number) {
    this.moveTo({ ...this.desired, radius: this.desired.radius * DOLLY_PER_NOTCH ** notches });
  }

  // -------------------------------------------------------------------------
  // Named views

  /** Back to where the photograph was taken from. */
  capture(scene: Scene): Pose {
    return poseBetween(scene.camera.position, scene.camera.target);
  }

  /** Standing up and looking level, from the photograph's side of the room. */
  front(): Pose {
    return {
      target: this.centreOfRoom(1.25),
      theta: this.centreTheta,
      phi: PHI_MAX - 0.08,
      radius: this.fitRadius(0.62),
    };
  }

  /** Looking straight down, far enough back that the whole plan is in shot. */
  top(): Pose {
    return {
      target: this.centreOfRoom(0.4),
      theta: this.centreTheta,
      phi: PHI_MIN,
      radius: this.fitRadius(1),
    };
  }

  /** Close enough to read one piece, without losing the room around it. */
  frameObject(object: SceneObject): Pose {
    const [w, h, d] = object.dimensions;
    const [sx, sy, sz] = object.transform.scale;
    const size = Math.max(w * sx, h * sy, d * sz);
    return {
      ...this.desired,
      target: objectCenter(object),
      radius: clamp(size * 2.6, 1.4, this.radiusMax),
    };
  }

  goTo(pose: Pose) {
    this.moveTo(pose);
  }

  get pose(): Pose {
    return this.desired;
  }

  // -------------------------------------------------------------------------

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private moveTo(pose: Pose) {
    if (this.disposed) return;
    this.desired = this.constrain(pose);
    if (this.instant) {
      this.current = this.desired;
      this.write();
      this.onChange();
      return;
    }
    if (!this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.step);
    }
  }

  private step = (now: number) => {
    this.frame = 0;
    if (this.disposed) return;
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    const k = 1 - Math.exp(-DAMPING * dt);
    const c = this.current;
    const d = this.desired;
    this.current = {
      target: [
        c.target[0] + (d.target[0] - c.target[0]) * k,
        c.target[1] + (d.target[1] - c.target[1]) * k,
        c.target[2] + (d.target[2] - c.target[2]) * k,
      ],
      theta: c.theta + (d.theta - c.theta) * k,
      phi: c.phi + (d.phi - c.phi) * k,
      radius: c.radius + (d.radius - c.radius) * k,
    };
    if (settled(this.current, d)) this.current = d;
    else this.frame = requestAnimationFrame(this.step);
    this.write();
    this.onChange();
  };

  /** The only place the view state's camera is written. */
  private write() {
    const { target, theta, phi, radius } = this.current;
    const sinPhi = Math.sin(phi);
    const camera = this.view.camera;
    camera.tx = target[0];
    camera.ty = target[1];
    camera.tz = target[2];
    camera.px = target[0] + radius * sinPhi * Math.sin(theta);
    camera.py = target[1] + radius * Math.cos(phi);
    camera.pz = target[2] + radius * sinPhi * Math.cos(theta);
  }

  private constrain(pose: Pose): Pose {
    const { min, max } = this.bounds;
    const inset = Math.min(TARGET_INSET, (max[0] - min[0]) / 4, (max[2] - min[2]) / 4);
    return {
      target: [
        clamp(pose.target[0], min[0] + inset, max[0] - inset),
        clamp(pose.target[1], inset, Math.max(inset, this.roomHeight - inset)),
        clamp(pose.target[2], min[2] + inset, max[2] - inset),
      ],
      theta: this.centreTheta + clamp(wrapAngle(pose.theta - this.centreTheta), -THETA_SPAN, THETA_SPAN),
      phi: clamp(pose.phi, PHI_MIN, PHI_MAX),
      radius: clamp(pose.radius, RADIUS_MIN, this.radiusMax),
    };
  }

  private centreOfRoom(height: number): Vec3 {
    const { min, max } = this.bounds;
    return [(min[0] + max[0]) / 2, height, (min[2] + max[2]) / 2];
  }

  /**
   * How far back the whole room sits in shot, from the vertical field of
   * view. `share` shrinks it for views that want to be closer in.
   */
  private fitRadius(share: number) {
    const { min, max } = this.bounds;
    const extent = Math.max(max[0] - min[0], max[2] - min[2], this.roomHeight);
    const half = Math.tan(degToRad(this.view.camera.fov) / 2);
    return clamp((extent / 2 / half) * share, RADIUS_MIN, this.radiusMax);
  }
}

// ---------------------------------------------------------------------------

export function poseBetween(position: Vec3, target: Vec3): Pose {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const radius = Math.max(Math.hypot(dx, dy, dz), 1e-4);
  return {
    target,
    theta: Math.atan2(dx, dz),
    phi: Math.acos(clamp(dy / radius, -1, 1)),
    radius,
  };
}

/** Into (-π, π], so a swing across due north is measured the short way. */
function wrapAngle(angle: number) {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function settled(a: Pose, b: Pose) {
  return (
    Math.abs(a.theta - b.theta) < 1e-4 &&
    Math.abs(a.phi - b.phi) < 1e-4 &&
    Math.abs(a.radius - b.radius) < 1e-3 &&
    Math.abs(a.target[0] - b.target[0]) < 1e-3 &&
    Math.abs(a.target[1] - b.target[1]) < 1e-3 &&
    Math.abs(a.target[2] - b.target[2]) < 1e-3
  );
}
