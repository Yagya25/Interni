import { block, cylinder, merge } from "../geometry";
import { group, part, type ObjectBuilder } from "./common";

export const coffeeTable: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const top = material("top", { sectionCaps: true });
  const legs = material("legs", { sectionCaps: true });

  if (object.form === "drum") {
    const r = w / 2;
    // A travertine drum with a shadow reveal under the top.
    return group(
      part(cylinder(r, r, 0.06, 64).translate(0, h - 0.06, 0), top),
      part(cylinder(r - 0.05, r - 0.05, 0.02, 64).translate(0, h - 0.08, 0), top),
      part(cylinder(r - 0.02, r - 0.02, h - 0.08, 64), legs),
    );
  }

  const slab = 0.035;
  const inset = 0.08;
  const legGeo = merge(
    [
      [-(w / 2) + inset, d / 2 - inset],
      [w / 2 - inset, d / 2 - inset],
      [-(w / 2) + inset, -(d / 2) + inset],
      [w / 2 - inset, -(d / 2) + inset],
    ].map(([x, z]) => block(0.022, h - slab, 0.022, 0.004).translate(x, 0, z)),
  );
  return group(
    part(block(w, slab, d, 0.008, 2).translate(0, h - slab, 0), top),
    part(legGeo, legs),
  );
};

export const sideTable: ObjectBuilder = ({ object, material }) => {
  const [w, h] = object.dimensions;
  const top = material("top", { sectionCaps: true });
  const r = w / 2;
  if (object.form === "block") {
    return group(part(cylinder(r, r, h, 48), top));
  }
  return group(
    part(
      merge([
        cylinder(r, r, 0.028, 48).translate(0, h - 0.028, 0),
        cylinder(0.03, 0.03, h - 0.04, 16).translate(0, 0.012, 0),
        cylinder(r * 0.62, r * 0.66, 0.018, 40),
      ]),
      top,
    ),
  );
};
