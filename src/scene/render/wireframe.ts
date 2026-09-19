/**
 * A wireframe of a room, projected without three.js.
 *
 * The WebGL stage is lazy-loaded and takes a moment to appear. Rather than
 * hold an empty box until it does, the page draws the room's shell — floor,
 * corners, ceiling line and openings — as plain SVG. It is computed from the
 * same Scene the stage renders and inlined into the HTML, so it costs no
 * request and is there in the first frame.
 *
 * The maths is deliberately small: a look-at basis and a perspective divide,
 * which is all a shell of straight edges needs.
 */
import type { Scene, Vec2, Vec3 } from "@/scene/model/types";

export interface Wireframe {
  /** Viewport the coordinates are expressed in. */
  width: number;
  height: number;
  /** Room shell: floor outline, corner posts and ceiling line. */
  shell: string;
  /** Window and door openings. */
  openings: string;
}

type Point = { x: number; y: number; depth: number };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Everything closer than this to the camera is behind the picture plane. */
const NEAR = 0.05;

/**
 * Project points with the camera that captured the scene. Returns a function
 * so the basis is built once per wireframe rather than once per point.
 */
function projector(scene: Scene, width: number, height: number) {
  const { position, target, verticalFov } = scene.camera;
  const forward = normalize(sub(target, position));
  // Degenerate only if the camera looks straight up or down, which a capture
  // camera does not.
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const halfHeight = Math.tan((verticalFov * Math.PI) / 360);
  const halfWidth = halfHeight * (width / height);

  return (p: Vec3): Point => {
    const d = sub(p, position);
    const depth = dot(d, forward);
    const safe = Math.max(depth, NEAR);
    return {
      x: ((dot(d, right) / (safe * halfWidth) + 1) / 2) * width,
      y: ((1 - dot(d, up) / (safe * halfHeight)) / 2) * height,
      depth,
    };
  };
}

/**
 * Trim a segment to the part in front of the camera, so an edge that runs
 * past the viewer is dropped rather than projected to a wild coordinate.
 */
function segment(a: Point, b: Point, project: (p: Vec3) => Point, pa: Vec3, pb: Vec3): string | null {
  if (a.depth <= NEAR && b.depth <= NEAR) return null;
  let from = a;
  let to = b;
  if (a.depth <= NEAR || b.depth <= NEAR) {
    const [near, far, nearPoint, farPoint] =
      a.depth <= NEAR ? [a, b, pa, pb] : [b, a, pb, pa];
    const t = (NEAR - near.depth) / (far.depth - near.depth);
    const clipped = project([
      nearPoint[0] + (farPoint[0] - nearPoint[0]) * t,
      nearPoint[1] + (farPoint[1] - nearPoint[1]) * t,
      nearPoint[2] + (farPoint[2] - nearPoint[2]) * t,
    ]);
    from = a.depth <= NEAR ? clipped : a;
    to = a.depth <= NEAR ? b : clipped;
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return `M${round(from.x)} ${round(from.y)}L${round(to.x)} ${round(to.y)}`;
}

/**
 * Build the wireframe. `width` and `height` set the coordinate space; the
 * camera's own aspect keeps the framing faithful to the render that follows.
 */
export function buildWireframe(scene: Scene, width = 900): Wireframe {
  const height = Math.round(width / scene.camera.aspect);
  const project = projector(scene, width, height);
  const { footprint, height: roomHeight } = scene.room;

  const path = (a: Vec3, b: Vec3) => segment(project(a), project(b), project, a, b);
  const shell: string[] = [];
  const at = (p: Vec2, y: number): Vec3 => [p[0], y, p[1]];

  for (let i = 0; i < footprint.length; i += 1) {
    const a = footprint[i];
    const b = footprint[(i + 1) % footprint.length];
    // Floor outline, the ceiling line above it, and the corner between them.
    shell.push(path(at(a, 0), at(b, 0)) ?? "");
    shell.push(path(at(a, roomHeight), at(b, roomHeight)) ?? "");
    shell.push(path(at(a, 0), at(a, roomHeight)) ?? "");
  }

  const openings: string[] = [];
  for (const opening of scene.openings) {
    const wall = scene.surfaces.find((s) => s.id === opening.wallId);
    if (!wall || wall.kind !== "wall") continue;
    const [sx, sz] = wall.start;
    const [ex, ez] = wall.end;
    const length = Math.hypot(ex - sx, ez - sz) || 1;
    const ux = (ex - sx) / length;
    const uz = (ez - sz) / length;
    const from = opening.offset - opening.width / 2;
    const to = opening.offset + opening.width / 2;
    const low = opening.sill;
    const high = opening.sill + opening.height;
    const corner = (along: number, y: number): Vec3 => [sx + ux * along, y, sz + uz * along];
    const box: [Vec3, Vec3][] = [
      [corner(from, low), corner(to, low)],
      [corner(to, low), corner(to, high)],
      [corner(to, high), corner(from, high)],
      [corner(from, high), corner(from, low)],
    ];
    for (const [a, b] of box) openings.push(path(a, b) ?? "");
  }

  return {
    width,
    height,
    shell: shell.filter(Boolean).join(""),
    openings: openings.filter(Boolean).join(""),
  };
}
