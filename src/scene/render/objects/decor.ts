import {
  BufferGeometry,
  DoubleSide,
  Euler,
  IcosahedronGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { block, cylinder, lathe, merge, metricUVs } from "../geometry";
import { group, part, type ObjectBuilder } from "./common";

export const rug: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const pile = material("pile");
  const geo = object.form === "round" ? cylinder(w / 2, w / 2, h, 96) : block(w, h, d, 0.004, 1);
  return group(part(geo, pile, 0, 0, 0, { castShadow: false }));
};

export const books: ObjectBuilder = ({ object, material }) => {
  const [w, , d] = object.dimensions;
  const cover = material("cover", { sectionCaps: true });
  const geo = merge([
    block(w, 0.032, d, 0.003, 1),
    block(w * 0.9, 0.028, d * 0.92, 0.003, 1).rotateY(0.08).translate(0.01, 0.032, 0),
    block(w * 0.8, 0.036, d * 0.84, 0.003, 1).rotateY(-0.12).translate(-0.01, 0.06, 0.005),
  ]);
  return group(part(geo, cover));
};

export const vase: ObjectBuilder = ({ object, material }) => {
  const [w, h] = object.dimensions;
  const body = material("body", { sectionCaps: true });
  const r = w / 2;
  if (object.form === "branches") {
    const vesselH = h * 0.38;
    const vessel = lathe(
      [
        [0.001, 0],
        [r * 0.7, 0],
        [r, vesselH * 0.45],
        [r * 0.55, vesselH * 0.9],
        [r * 0.45, vesselH],
      ],
      40,
    );
    const foliage = material("foliage", { side: DoubleSide });
    return group(part(vessel, body), part(branches(r * 0.4, vesselH, h), foliage));
  }
  const profile: [number, number][] = [
    [0.001, 0],
    [r * 0.8, 0],
    [r, h * 0.3],
    [r * 0.92, h * 0.62],
    [r * 0.36, h * 0.8],
    [r * 0.3, h],
  ];
  return group(part(lathe(profile, 40), body));
};

/** A few bare branches with small leaves, merged into one geometry. */
function branches(spread: number, base: number, top: number) {
  const parts: BufferGeometry[] = [];
  const up = new Vector3(0, 1, 0);
  const stems = [
    { lean: 0.25, turn: 0.4, len: top - base },
    { lean: 0.4, turn: 2.6, len: (top - base) * 0.85 },
    { lean: 0.15, turn: 4.4, len: (top - base) * 0.95 },
  ];
  stems.forEach(({ lean, turn, len }, s) => {
    const dir = new Vector3(Math.sin(turn) * Math.sin(lean), Math.cos(lean), Math.cos(turn) * Math.sin(lean));
    const q = new Quaternion().setFromUnitVectors(up, dir);
    parts.push(cylinder(0.003, 0.005, len, 5).applyQuaternion(q).translate(0, base - 0.02, 0));
    for (let i = 0; i < 14; i++) {
      const t = 0.35 + (i / 14) * 0.65;
      const p = dir.clone().multiplyScalar(len * t).add(new Vector3(0, base - 0.02, 0));
      const leaf = new IcosahedronGeometry(1, 0).scale(0.012, 0.004, 0.03);
      leaf.rotateY(i * 2.4 + s).rotateX(0.6);
      leaf.translate(p.x + Math.sin(i * 1.7) * spread * 0.3, p.y, p.z + Math.cos(i * 1.7) * spread * 0.3);
      parts.push(metricUVs(leaf));
    }
  });
  return merge(parts);
}

export const basket: ObjectBuilder = ({ object, material }) => {
  const [w, h] = object.dimensions;
  const weave = material("weave", { side: DoubleSide });
  const r = w / 2;
  const geo = lathe(
    [
      [0.001, 0.005],
      [r * 0.9, 0.005],
      [r, h * 0.2],
      [r, h],
      [r - 0.012, h],
      [r - 0.012, h * 0.2],
      [r * 0.88, 0.02],
      [0.001, 0.02],
    ],
    40,
  );
  return group(part(geo, weave));
};

export const plant: ObjectBuilder = ({ object, material }) => {
  const [w, h] = object.dimensions;
  const pot = material("pot", { sectionCaps: true });
  const foliage = material("foliage", { side: DoubleSide });
  const olive = object.form === "olive";
  const potR = olive ? w * 0.3 : w * 0.32;
  const potH = olive ? 0.46 : 0.38;
  const potGeo = lathe(
    olive
      ? [
          [0.001, 0],
          [potR * 0.72, 0],
          [potR, potH * 0.9],
          [potR * 1.05, potH],
          [potR * 0.92, potH],
          [potR * 0.9, potH * 0.92],
          [0.001, potH * 0.92],
        ]
      : [
          [0.001, 0],
          [potR * 0.85, 0],
          [potR, potH],
          [potR * 0.93, potH],
          [0.001, potH * 0.94],
        ],
    40,
  );
  const { leaves, stems } = olive ? oliveCanopy(w, h, potH) : fiddleLeaf(h, potH);
  return group(
    part(potGeo, pot),
    part(stems, material("stem", { sectionCaps: true })),
    part(leaves, foliage),
    // Soil, a shade below the rim, in the stem's dark tone.
    part(cylinder(potR * 0.9, potR * 0.9, 0.01, 32).translate(0, potH * 0.88, 0), material("stem")),
  );
};

function fiddleLeaf(h: number, potH: number) {
  const stems = cylinder(0.012, 0.018, h - potH - 0.15, 8).translate(0, potH - 0.05, 0);
  const parts: BufferGeometry[] = [];
  const leaf = () => {
    const g = new PlaneGeometry(0.2, 0.28, 2, 3);
    const pos = g.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // Violin-shaped taper and a gentle fold along the midrib.
      const taper = 1 - Math.pow((y + 0.14) / 0.28, 2) * 0.55;
      pos.setX(i, x * taper);
      pos.setZ(i, -Math.abs(x) * 0.35 + Math.sin((y + 0.14) * 6) * 0.01);
    }
    g.translate(0, 0.16, 0);
    return g;
  };
  const count = 30;
  const m = new Matrix4();
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const y = potH + 0.18 + t * (h - potH - 0.3);
    const g = leaf();
    const scale = 0.75 + Math.sin(t * Math.PI) * 0.5;
    m.compose(
      new Vector3(0, y, 0),
      new Quaternion().setFromEuler(new Euler(-0.7 - t * 0.3 + Math.sin(i) * 0.2, i * 2.39996, 0, "YXZ")),
      new Vector3(scale, scale, scale),
    );
    g.applyMatrix4(m);
    parts.push(metricUVs(g));
  }
  return { leaves: merge(parts), stems };
}

/** Deterministic pseudo-random in [0, 1). */
const hash01 = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

function oliveCanopy(w: number, h: number, potH: number) {
  const leaves: BufferGeometry[] = [];
  const stems: BufferGeometry[] = [];
  const up = new Vector3(0, 1, 0);
  const fork = new Vector3(0.02, h * 0.5, 0);
  const branch = (from: Vector3, to: Vector3, r0: number, r1: number) =>
    stems.push(
      cylinder(r1, r0, from.distanceTo(to), 6)
        .applyQuaternion(new Quaternion().setFromUnitVectors(up, to.clone().sub(from).normalize()))
        .translate(from.x, from.y, from.z),
    );
  branch(new Vector3(0, potH - 0.05, 0), fork, 0.034, 0.024);

  const clusters = [
    new Vector3(-0.22, h * 0.72, 0.08),
    new Vector3(0.24, h * 0.76, -0.06),
    new Vector3(0.02, h * 0.88, -0.1),
    new Vector3(-0.1, h * 0.95, 0.12),
    new Vector3(0.18, h * 0.64, 0.16),
    new Vector3(-0.26, h * 0.86, -0.14),
  ];
  clusters.forEach((c, k) => {
    branch(fork, c, 0.018, 0.008);
    const radius = (w / 2) * (0.42 + (k % 3) * 0.08);
    for (let i = 0; i < 150; i++) {
      const seed = i * 7.13 + k * 101.7;
      const a = hash01(seed) * Math.PI * 2;
      const b = Math.acos(2 * hash01(seed + 3.1) - 1);
      const rr = radius * Math.cbrt(0.2 + 0.8 * hash01(seed + 5.7));
      const p = new Vector3(Math.sin(b) * Math.cos(a) * rr, Math.cos(b) * rr * 0.6, Math.sin(b) * Math.sin(a) * rr).add(c);
      // Narrow lanceolate leaves, silvered on one side by the lighting.
      const leaf = new IcosahedronGeometry(1, 0).scale(0.011, 0.0025, 0.05);
      leaf.rotateY(a + hash01(seed + 9) * 0.8).rotateX(0.4 + hash01(seed + 11) * 0.9);
      leaf.translate(p.x, p.y, p.z);
      leaves.push(metricUVs(leaf));
    }
  });
  return { leaves: merge(leaves), stems: merge(stems) };
}

export const artwork: ObjectBuilder = ({ object, material, textures }) => {
  const [w, h, d] = object.dimensions;
  const frame = material("frame", { sectionCaps: true });
  // The image gets its own instance so the mat around it stays plain paper.
  const image = material("surface", { key: "image" });
  image.color.set("#ffffff");

  if (object.form === "canvas") {
    image.map = textures.image(`${object.id}-canvas`, 768, 560, (ctx, width, rand) => {
      const height = ctx.canvas.height;
      // Two earth fields and a charcoal bar, softly brushed.
      ctx.fillStyle = "#d9c7ab";
      ctx.fillRect(0, 0, width, height);
      const brush = (x: number, y: number, bw: number, bh: number, color: string) => {
        ctx.fillStyle = color;
        for (let i = 0; i < 60; i++) {
          ctx.globalAlpha = 0.05 + rand() * 0.06;
          ctx.fillRect(x + (rand() - 0.5) * 12, y + (rand() - 0.5) * 12, bw, bh);
        }
        ctx.globalAlpha = 1;
      };
      brush(width * 0.08, height * 0.1, width * 0.5, height * 0.62, "#9c5a36");
      brush(width * 0.46, height * 0.34, width * 0.44, height * 0.56, "#c49a62");
      brush(width * 0.12, height * 0.78, width * 0.62, height * 0.06, "#2d2a26");
    });
    // Plane UVs stay 0..1 so the painting maps exactly once.
    const face = new PlaneGeometry(w - 0.004, h - 0.004).translate(0, h / 2, d + 0.0015);
    return group(
      part(block(w, h, d, 0.004, 1).translate(0, 0, d / 2), frame),
      part(face, image, 0, 0, 0, { castShadow: false }),
    );
  }

  image.map = textures.image(`${object.id}-print`, 600, 460, (ctx, width) => {
    const height = ctx.canvas.height;
    ctx.fillStyle = "#efeae1";
    ctx.fillRect(0, 0, width, height);
    // A quiet architectural print: an arch, a low sun, a horizon.
    ctx.strokeStyle = "#3a3632";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(width * 0.2, height * 0.72);
    ctx.arc(width * 0.4, height * 0.72, width * 0.2, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = "#b8703f";
    ctx.beginPath();
    ctx.arc(width * 0.66, height * 0.36, width * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3a3632";
    ctx.fillRect(width * 0.12, height * 0.72, width * 0.76, 3);
  });
  const border = 0.028;
  const frameGeo = merge([
    block(w, border, d, 0.003, 1),
    block(w, border, d, 0.003, 1).translate(0, h - border, 0),
    block(border, h - border * 2, d, 0.003, 1).translate(-(w - border) / 2, border, 0),
    block(border, h - border * 2, d, 0.003, 1).translate((w - border) / 2, border, 0),
  ]).translate(0, 0, d / 2);
  const matW = w - border * 2;
  const matH = h - border * 2;
  return group(
    part(frameGeo, frame),
    part(new PlaneGeometry(matW, matH).translate(0, h / 2, d * 0.4), material("surface"), 0, 0, 0, {
      castShadow: false,
    }),
    part(new PlaneGeometry(matW * 0.62, matH * 0.62).translate(0, h / 2, d * 0.4 + 0.001), image, 0, 0, 0, {
      castShadow: false,
    }),
  );
};

export const curtain: ObjectBuilder = ({ object, material }) => {
  const [w, h] = object.dimensions;
  const fabric = material("fabric", { side: DoubleSide });
  const g = new PlaneGeometry(w, h - 0.02, 36, 1);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, Math.sin((x / w) * Math.PI * 9) * 0.035);
  }
  g.computeVertexNormals();
  g.translate(0, h / 2, 0);
  return group(part(metricUVs(g), fabric));
};
