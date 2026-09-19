import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  LatheGeometry,
  SphereGeometry,
  Vector2,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Geometry helpers. All UVs are rewritten in metres (box projection) so a
 * texture tiled at "0.35 m per repeat" has the same physical scale on a
 * cushion and on a sofa arm.
 */
export function metricUVs<T extends BufferGeometry>(geometry: T): T {
  const position = geometry.getAttribute("position");
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    if (ny >= nx && ny >= nz) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = z;
    } else if (nx >= nz) {
      uv[i * 2] = z;
      uv[i * 2 + 1] = y;
    } else {
      uv[i * 2] = x;
      uv[i * 2 + 1] = y;
    }
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  return geometry;
}

/** A soft-edged block with its base at y = 0. */
export function block(w: number, h: number, d: number, radius = 0.02, segments = 3) {
  const r = Math.min(radius, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const geometry =
    r > 0.0015
      ? new RoundedBoxGeometry(w, h, d, segments, r)
      : new RoundedBoxGeometry(w, h, d, 1, 0.0005);
  geometry.translate(0, h / 2, 0);
  return metricUVs(geometry);
}

export function cylinder(rTop: number, rBottom: number, h: number, segments = 32, open = false) {
  const geometry = new CylinderGeometry(rTop, rBottom, h, segments, 1, open);
  geometry.translate(0, h / 2, 0);
  return metricUVs(geometry);
}

export function sphere(r: number, widthSegments = 32, heightSegments = 20) {
  return metricUVs(new SphereGeometry(r, widthSegments, heightSegments));
}

/** Revolve a profile of [radius, height] points around Y. */
export function lathe(profile: readonly [number, number][], segments = 40) {
  return metricUVs(
    new LatheGeometry(
      profile.map(([r, y]) => new Vector2(r, y)),
      segments,
    ),
  );
}

/** Merge parts that share one material into a single draw call. */
export function merge(parts: BufferGeometry[]) {
  const nonIndexed = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  // Every part must expose the same attributes to be merged.
  nonIndexed.forEach((g) => {
    if (!g.getAttribute("uv")) metricUVs(g);
  });
  const merged = mergeGeometries(nonIndexed, false);
  parts.forEach((g) => g.dispose());
  nonIndexed.forEach((g) => g.dispose());
  if (!merged) throw new Error("Failed to merge geometries");
  return merged;
}
