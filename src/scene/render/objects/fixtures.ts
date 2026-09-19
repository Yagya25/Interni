import { CircleGeometry, DoubleSide, SphereGeometry, TorusGeometry } from "three";
import { cylinder, merge, metricUVs, sphere } from "../geometry";
import { group, part, type ObjectBuilder } from "./common";

/**
 * Light fixtures. Shades use emissive materials whose intensity the stage
 * drives from the lighting state; the light itself is part of the rig.
 */

export const floorLamp: ObjectBuilder = ({ object, material }) => {
  const [w, h] = object.dimensions;
  const stand = material("stand", { sectionCaps: true });

  if (object.form === "globe") {
    const shade = material("shade");
    const r = w / 2;
    return group(
      part(merge([cylinder(0.14, 0.15, 0.02, 32), cylinder(0.009, 0.009, h - r * 2, 12)]), stand),
      part(sphere(r, 40, 28).translate(0, h - r, 0), shade, 0, 0, 0, { castShadow: false }),
    );
  }

  const shade = material("shade", { side: DoubleSide });
  const shadeH = 0.3;
  const shadeR = w / 2;
  const legLen = h - shadeH * 0.55;
  const splay = 0.16;
  const legs = merge(
    [0, 1, 2].map((i) => {
      const a = (i / 3) * Math.PI * 2 + 0.3;
      return cylinder(0.011, 0.014, legLen, 10)
        .rotateX(splay)
        .rotateY(a)
        .translate(Math.sin(a) * 0.02, 0, Math.cos(a) * 0.02);
    }),
  );
  return group(
    part(legs, stand),
    part(cylinder(shadeR * 0.94, shadeR, shadeH, 48, true).translate(0, h - shadeH, 0), shade, 0, 0, 0, {
      castShadow: false,
    }),
  );
};

export const pendantLamp: ObjectBuilder = ({ object, material }) => {
  const [w, h] = object.dimensions;
  const shade = material("shade", { side: DoubleSide });
  const cordMat = material("shade");

  if (object.form === "lantern") {
    const r = w / 2;
    const bodyH = r * 1.7;
    const globe = metricUVs(new SphereGeometry(r, 48, 32));
    globe.scale(1, bodyH / (r * 2), 1).translate(0, bodyH / 2, 0);
    const ribs = merge(
      [0.2, 0.35, 0.5, 0.65, 0.8].map((t) => {
        const y = bodyH * t;
        const ry = Math.sqrt(Math.max(0, 1 - ((y - bodyH / 2) / (bodyH / 2)) ** 2)) * r;
        return metricUVs(new TorusGeometry(ry + 0.002, 0.003, 6, 48).rotateX(Math.PI / 2).translate(0, y, 0));
      }),
    );
    return group(
      part(globe, shade, 0, 0, 0, { castShadow: false }),
      part(ribs, shade, 0, 0, 0, { castShadow: false }),
      part(cylinder(0.004, 0.004, h - bodyH, 6).translate(0, bodyH, 0), cordMat),
    );
  }

  const r = w / 2;
  const domeH = 0.2;
  const dome = metricUVs(new SphereGeometry(r, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2));
  dome.scale(1, domeH / r, 1);
  const diffuser = metricUVs(new CircleGeometry(r * 0.72, 40).rotateX(Math.PI / 2)).translate(0, 0.04, 0);
  return group(
    part(dome, shade, 0, 0, 0, { castShadow: false }),
    part(diffuser, material("diffuser"), 0, 0, 0, { castShadow: false }),
    part(cylinder(0.004, 0.004, h - domeH, 6).translate(0, domeH, 0), shade),
  );
};
