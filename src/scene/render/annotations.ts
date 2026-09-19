import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Vector3,
} from "three";

/**
 * Hairline annotations drawn in the scene: the visual language of an
 * architectural drawing laid over the room.
 */

const INK = new Color("#191816");

export function lineMaterial(opacity = 0, color: Color = INK) {
  return new LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

/**
 * Corner brackets of an object's bounding box, in the object's local frame
 * (origin at the base centre). Only the corners are drawn so the object
 * itself stays readable.
 */
export function bracketBox(dimensions: readonly [number, number, number], material: LineBasicMaterial) {
  const pad = 0.025;
  const [w, h, d] = dimensions;
  const x = w / 2 + pad;
  const z = d / 2 + pad;
  const y0 = -0.005;
  const y1 = h + pad;
  const tick = Math.min(0.14, Math.max(0.04, Math.min(w, h, d) * 0.3));
  const points: number[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [0, 1]) {
      for (const sz of [-1, 1]) {
        const cx = sx * x;
        const cy = sy ? y1 : y0;
        const cz = sz * z;
        points.push(cx, cy, cz, cx - sx * tick, cy, cz);
        points.push(cx, cy, cz, cx, cy + (sy ? -tick : tick), cz);
        points.push(cx, cy, cz, cx, cy, cz - sz * tick);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(points), 3));
  const lines = new LineSegments(geometry, material);
  lines.renderOrder = 10;
  lines.frustumCulled = false;
  return lines;
}

/** A set of segments whose endpoints are rewritten every frame. */
export class DynamicSegments {
  readonly lines: LineSegments;
  private readonly positions: Float32Array;

  constructor(count: number, material: LineBasicMaterial | LineDashedMaterial) {
    this.positions = new Float32Array(count * 6);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.lines = new LineSegments(geometry, material);
    this.lines.renderOrder = 10;
    this.lines.frustumCulled = false;
  }

  set(index: number, a: Vector3, b: Vector3) {
    this.positions.set([a.x, a.y, a.z, b.x, b.y, b.z], index * 6);
  }

  commit() {
    const attribute = this.lines.geometry.getAttribute("position") as BufferAttribute;
    attribute.needsUpdate = true;
    if (this.lines.material instanceof LineDashedMaterial) this.lines.computeLineDistances();
  }
}

/**
 * Dimension strings in the architectural convention: extension lines,
 * a dimension line and 45° ticks at each end.
 */
export function dimensionString(
  from: Vector3,
  to: Vector3,
  offset: Vector3,
  material: LineBasicMaterial,
): LineSegments {
  const a = from.clone().add(offset);
  const b = to.clone().add(offset);
  const along = b.clone().sub(a).normalize();
  const side = offset.clone().normalize();
  const tickDir = along.clone().add(side).normalize().multiplyScalar(0.07);
  const ext = side.clone().multiplyScalar(0.08);
  const pts = [
    // extension lines
    from.clone().addScaledVector(side, 0.06), a.clone().add(ext),
    to.clone().addScaledVector(side, 0.06), b.clone().add(ext),
    // dimension line
    a, b,
    // ticks
    a.clone().sub(tickDir), a.clone().add(tickDir),
    b.clone().sub(tickDir), b.clone().add(tickDir),
  ];
  const geometry = new BufferGeometry().setFromPoints(pts);
  const lines = new LineSegments(geometry, material);
  lines.renderOrder = 10;
  lines.frustumCulled = false;
  return lines;
}
