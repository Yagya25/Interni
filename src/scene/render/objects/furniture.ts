import { block, merge } from "../geometry";
import { group, part, type ObjectBuilder } from "./common";

/**
 * Case goods, tables, chairs, beds and screens.
 *
 * Parametric like the rest: every builder is driven by the object's own
 * [width, height, depth], and by named parameters in its metadata where the
 * reconstruction measured them (a seat height, a tabletop thickness, how a
 * TV is mounted). A parameter that was not measured falls back to a stated
 * default here, never to a guess dressed as a measurement.
 */

/** A numeric parameter from the object's metadata, or the builder's default. */
export const param = (metadata: Readonly<Record<string, string | number | boolean>> | undefined, key: string, fallback: number) => {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const corners = (w: number, d: number, inset: number) => [
  [-(w / 2) + inset, d / 2 - inset],
  [w / 2 - inset, d / 2 - inset],
  [-(w / 2) + inset, -(d / 2) + inset],
  [w / 2 - inset, -(d / 2) + inset],
];

/** Four legs, a seat and a back with a top rail. Parameters: seatHeight. */
export const chair: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const frame = material("frame", { sectionCaps: true });
  const seat = material("seat", { sectionCaps: true });
  const seatH = Math.min(param(object.metadata, "seatHeight", 0.46), h - 0.15);
  const leg = Math.min(0.04, w / 10);
  const rail = Math.min(0.12, (h - seatH) * 0.3);
  const frameGeo = merge([
    ...corners(w, d, leg / 2).map(([x, z]) => block(leg, seatH - 0.035, leg, 0.004).translate(x, 0, z)),
    // back posts rise from the rear legs
    block(leg, h - seatH + 0.035, leg, 0.004).translate(-(w / 2) + leg / 2, seatH - 0.035, -(d / 2) + leg / 2),
    block(leg, h - seatH + 0.035, leg, 0.004).translate(w / 2 - leg / 2, seatH - 0.035, -(d / 2) + leg / 2),
    block(w - leg, rail, leg * 0.8, 0.006).translate(0, h - rail, -(d / 2) + leg / 2),
    block(w - leg, 0.03, leg * 0.6, 0.004).translate(0, seatH + (h - seatH) * 0.35, -(d / 2) + leg / 2),
  ]);
  return group(part(frameGeo, frame), part(block(w, 0.035, d, 0.008).translate(0, seatH - 0.035, 0), seat));
};

/** A top on four legs. Parameters: topThickness. */
const leggedTable = (legInset: number): ObjectBuilder => ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const top = material("top", { sectionCaps: true });
  const legs = material("legs", { sectionCaps: true });
  const thickness = param(object.metadata, "topThickness", 0.035);
  const leg = 0.05;
  const legGeo = merge(corners(w, d, legInset).map(([x, z]) => block(leg, h - thickness, leg, 0.006).translate(x, 0, z)));
  return group(part(block(w, thickness, d, 0.006, 2).translate(0, h - thickness, 0), top), part(legGeo, legs));
};

export const diningTable = leggedTable(0.08);
export const desk = leggedTable(0.04);

/** A carcass with a plinth and a door or drawer front split. */
export const cabinet: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const body = material("body", { sectionCaps: true });
  const plinth = Math.min(0.08, h * 0.08);
  const doors = Math.max(1, Math.round(w / 0.5));
  const doorW = w / doors;
  const geo = merge([
    block(w - 0.04, plinth, d - 0.04, 0.004).translate(0, 0, -0.01),
    block(w, h - plinth, d - 0.02, 0.006).translate(0, plinth, -0.01),
    // door fronts stand proud of the carcass by a few millimetres
    ...Array.from({ length: doors }, (_, i) =>
      block(doorW - 0.008, h - plinth - 0.01, 0.018, 0.004).translate(-w / 2 + doorW * (i + 0.5), plinth + 0.005, d / 2 - 0.02),
    ),
  ]);
  return group(part(geo, body));
};

/** A low console: a carcass on short legs with drawer fronts. */
export const mediaConsole: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const body = material("body", { sectionCaps: true });
  const legs = material("legs", { sectionCaps: true });
  const legH = Math.min(0.1, h * 0.18);
  const bays = Math.max(2, Math.round(w / 0.45));
  const bayW = w / bays;
  const carcass = merge([
    block(w, h - legH, d - 0.02, 0.008).translate(0, legH, -0.01),
    ...Array.from({ length: bays }, (_, i) =>
      block(bayW - 0.01, h - legH - 0.03, 0.016, 0.004).translate(-w / 2 + bayW * (i + 0.5), legH + 0.015, d / 2 - 0.02),
    ),
  ]);
  const legGeo = merge(corners(w, d, 0.06).map(([x, z]) => block(0.04, legH, 0.04, 0.006).translate(x, 0, z)));
  return group(part(carcass, body), part(legGeo, legs));
};

/** Shelving: sides, a back and evenly spaced shelves. */
export const bookshelf: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const body = material("body", { sectionCaps: true });
  const t = 0.022;
  const shelves = Math.max(2, Math.round(h / 0.38));
  const geo = merge([
    block(t, h, d, 0.003).translate(-(w / 2) + t / 2, 0, 0),
    block(t, h, d, 0.003).translate(w / 2 - t / 2, 0, 0),
    block(w, h, 0.01, 0.002).translate(0, 0, -(d / 2) + 0.005),
    ...Array.from({ length: shelves + 1 }, (_, i) => block(w - t * 2, t, d - 0.01, 0.003).translate(0, (h - t) * (i / shelves), 0.005)),
  ]);
  return group(part(geo, body));
};

/** A thin panel with a bezel; on a stand unless it hangs on a wall. Parameters: mount. */
export const television: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const screen = material("screen", { sectionCaps: true });
  const frame = material("frame", { sectionCaps: true });
  const onStand = object.metadata?.mount === "stand";
  const foot = onStand ? Math.min(0.08, h * 0.12) : 0;
  const panelH = h - foot;
  const bezel = Math.min(0.012, w * 0.01);
  const body = merge([
    block(w, panelH, Math.max(0.012, d * 0.5), 0.004).translate(0, foot, -d * 0.25),
    ...(onStand
      ? [block(w * 0.35, 0.015, Math.max(0.18, d * 3), 0.004), block(0.05, foot, 0.03, 0.004).translate(0, 0, -0.01)]
      : []),
  ]);
  const glass = block(w - bezel * 2, panelH - bezel * 2, 0.004, 0.001).translate(0, foot + bezel, Math.max(0.006, d * 0.25) - d * 0.25);
  return group(part(body, frame), part(glass, screen, 0, 0, 0, { castShadow: false }));
};

/** A frame with a headboard and a mattress. */
export const bed: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const frame = material("frame", { sectionCaps: true });
  const bedding = material("bedding", { sectionCaps: true });
  // The headboard is the tallest part and stays within the piece's own height.
  const base = Math.min(0.3, h * 0.35);
  const mattress = Math.min(0.22, h * 0.25);
  return group(
    part(
      merge([
        block(w, base, d, 0.01),
        block(w, h, 0.06, 0.01).translate(0, 0, -(d / 2) + 0.03),
      ]),
      frame,
    ),
    part(block(w - 0.04, mattress, d - 0.1, 0.05).translate(0, base, 0.03), bedding),
  );
};
