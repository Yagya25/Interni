import { ExtrudeGeometry, Shape } from "three";
import { block, cylinder, merge, metricUVs } from "../geometry";
import { group, part, type ObjectBuilder } from "./common";

/** Tapered timber leg. */
const leg = (h: number, r = 0.018) => cylinder(r * 0.75, r, h, 12);

export const sofa: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const fabric = material("upholstery", { sectionCaps: true });
  const legs = material("legs", { sectionCaps: true });

  if (object.form === "curved") return curvedSofa(w, h, d, fabric, legs);

  const legH = 0.1;
  const armW = 0.16;
  const seatH = 0.42;
  const baseTop = legH + 0.2;
  const innerW = w - armW * 2;
  const seats = 3;
  const seatW = innerW / seats;

  const upholstery = merge([
    // base
    block(w - 0.02, 0.2, d - 0.02, 0.03).translate(0, legH, 0),
    // arms
    block(armW, h - legH - 0.06, d, 0.05).translate(-(w - armW) / 2, legH, 0),
    block(armW, h - legH - 0.06, d, 0.05).translate((w - armW) / 2, legH, 0),
    // back
    block(innerW, h - legH - 0.04, 0.2, 0.05).translate(0, legH, -(d - 0.2) / 2),
    // seat cushions
    ...Array.from({ length: seats }, (_, i) =>
      block(seatW - 0.012, seatH - baseTop + 0.02, d - 0.26, 0.05).translate(
        -innerW / 2 + seatW * (i + 0.5),
        baseTop - 0.01,
        0.1,
      ),
    ),
    // back cushions, leaning
    ...Array.from({ length: seats }, (_, i) =>
      block(seatW - 0.02, 0.4, 0.17, 0.07)
        .rotateX(-0.16)
        .translate(-innerW / 2 + seatW * (i + 0.5), seatH - 0.02, -(d / 2) + 0.26),
    ),
  ]);

  const legGeo = merge(
    [
      [-(w / 2) + 0.07, (d / 2) - 0.07],
      [(w / 2) - 0.07, (d / 2) - 0.07],
      [-(w / 2) + 0.07, -(d / 2) + 0.07],
      [(w / 2) - 0.07, -(d / 2) + 0.07],
    ].map(([x, z]) => leg(legH).translate(x, 0, z)),
  );

  return group(part(upholstery, fabric), part(legGeo, legs));
};

function curvedSofa(
  w: number,
  h: number,
  d: number,
  fabric: ReturnType<Parameters<ObjectBuilder>[0]["material"]>,
  legs: ReturnType<Parameters<ObjectBuilder>[0]["material"]>,
) {
  // An arc band whose ends come forward to hold the conversation.
  const sagitta = 0.34;
  const radius = (w * w) / (8 * sagitta) + sagitta / 2;
  const half = Math.asin(w / 2 / radius);
  const centreZ = -d / 2 + radius;

  const band = (inner: number, outer: number) => {
    const shape = new Shape();
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const a = -half + (2 * half * i) / steps;
      const x = Math.sin(a) * outer;
      const z = centreZ - Math.cos(a) * outer;
      if (i === 0) shape.moveTo(x, -z);
      else shape.lineTo(x, -z);
    }
    for (let i = steps; i >= 0; i--) {
      const a = -half + (2 * half * i) / steps;
      shape.lineTo(Math.sin(a) * inner, -(centreZ - Math.cos(a) * inner));
    }
    shape.closePath();
    return shape;
  };

  const extrude = (shape: Shape, depth: number, bevel: number) => {
    const g = new ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 4,
      curveSegments: 48,
    });
    g.rotateX(-Math.PI / 2);
    return metricUVs(g);
  };

  // Bevels add their thickness above and below each extrusion, so the seat
  // top lands at ~0.42 m and the back at the object's full height.
  const plinth = 0.08;
  const seat = extrude(band(radius - d + 0.08, radius - 0.06), 0.24, 0.05).translate(0, plinth + 0.05, 0);
  const back = extrude(band(radius - 0.24, radius - 0.05), h - plinth - 0.12, 0.06).translate(
    0,
    plinth + 0.06,
    0,
  );
  const base = extrude(band(radius - d + 0.16, radius - 0.14), plinth - 0.01, 0.005);

  return group(part(merge([seat, back]), fabric), part(base, legs));
}

export const armchair: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const skin = material("upholstery", { sectionCaps: true });
  const legs = material("legs", { sectionCaps: true });
  const legH = 0.09;
  const armW = 0.17;
  const body = merge([
    block(w, 0.24, d, 0.05).translate(0, legH, 0),
    block(armW, 0.62 - legH, d - 0.02, 0.07).translate(-(w - armW) / 2, legH, 0),
    block(armW, 0.62 - legH, d - 0.02, 0.07).translate((w - armW) / 2, legH, 0),
    block(w - 0.04, h - legH, 0.22, 0.08).translate(0, legH, -(d - 0.22) / 2),
    block(w - armW * 2 - 0.02, 0.16, d - 0.26, 0.06).translate(0, legH + 0.22, 0.1),
  ]);
  const legGeo = merge(
    [
      [-(w / 2) + 0.08, (d / 2) - 0.08],
      [(w / 2) - 0.08, (d / 2) - 0.08],
      [-(w / 2) + 0.08, -(d / 2) + 0.08],
      [(w / 2) - 0.08, -(d / 2) + 0.08],
    ].map(([x, z]) => leg(legH, 0.02).translate(x, 0, z)),
  );
  return group(part(body, skin), part(legGeo, legs));
};

/** Low timber frame with a leather sling seat and back. */
export const loungeChair: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const seat = material("seat", { sectionCaps: true });
  const frame = material("frame", { sectionCaps: true });
  const rail = 0.035;
  const side = (x: number) => [
    block(rail, rail, d, 0.008).translate(x, 0.36, 0),
    block(rail, 0.38, rail, 0.008).translate(x, 0, d / 2 - 0.06),
    block(rail, 0.36, rail, 0.008).translate(x, 0, -d / 2 + 0.06),
    block(rail, h - 0.02, rail, 0.008).rotateX(-0.32).translate(x, 0.02, -d / 2 + 0.1),
    block(rail, rail, d * 0.8, 0.008).translate(x, 0.58, 0.02),
  ];
  const frameGeo = merge([...side(-(w / 2) + rail / 2), ...side(w / 2 - rail / 2)]);
  const sling = merge([
    block(w - rail * 2 - 0.01, 0.08, d * 0.7, 0.035).rotateX(0.1).translate(0, 0.3, 0.06),
    block(w - rail * 2 - 0.01, h * 0.62, 0.08, 0.035).rotateX(-0.34).translate(0, 0.32, -d / 2 + 0.2),
  ]);
  return group(part(frameGeo, frame), part(sling, seat));
};

export const ottoman: ObjectBuilder = ({ object, material }) => {
  const [w, h] = object.dimensions;
  const r = w / 2;
  const cover = material("cover", { sectionCaps: true });
  const body = merge([
    cylinder(r, r - 0.01, h - 0.05, 40).translate(0, 0, 0),
    cylinder(r - 0.035, r, 0.05, 40).translate(0, h - 0.05, 0),
  ]);
  return group(part(body, cover));
};

export const bench: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const top = material("top", { sectionCaps: true });
  const slats = 5;
  const slatD = d / slats;
  const geo = merge([
    ...Array.from({ length: slats }, (_, i) =>
      block(w, 0.035, slatD - 0.012, 0.006).translate(0, h - 0.035, -d / 2 + slatD * (i + 0.5)),
    ),
    block(0.05, h - 0.035, d - 0.04, 0.008).translate(-(w / 2) + 0.12, 0, 0),
    block(0.05, h - 0.035, d - 0.04, 0.008).translate(w / 2 - 0.12, 0, 0),
    block(w - 0.24, 0.04, 0.04, 0.008).translate(0, 0.12, 0),
  ]);
  return group(part(geo, top));
};

export const cushions: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const cover = material("cover", { sectionCaps: true });
  const size = h;
  const geo = merge([
    block(size, size, d, 0.07).rotateZ(0.08).rotateX(-0.25).translate(-w / 2 + size / 2, 0, 0),
    block(size * 0.92, size * 0.92, d, 0.07).rotateZ(-0.1).rotateX(-0.25).translate(w / 2 - size / 2, 0, 0),
  ]);
  return group(part(geo, cover));
};
