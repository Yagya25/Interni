import { extentOf, isPolygon, perimeterOf, polygonArea } from "./geometry";
import { roomInput, withScale, type Knowledge } from "./provenance";
import { measurement, unavailable, type Bound, type Measured, type MeasuredInput } from "./types";

/** The room's own dimensions, from its footprint and height. */
export interface RoomMeasurements {
  /** Extent across the room (X). */
  width: Measured;
  /** Extent along the room (Z). */
  depth: Measured;
  height: Measured;
  /** The floor inside the footprint, m². */
  floorArea: Measured;
  perimeter: Measured;
}

export function measureRoom(k: Knowledge): RoomMeasurements {
  const { footprint, height } = k.scene.room;
  const width = roomInput(k, "width");
  const depth = roomInput(k, "depth");
  const tall = roomInput(k, "height");
  if (!isPolygon(footprint)) {
    const no = unavailable("the room's footprint is not a closed outline with an area");
    return { width: no, depth: no, height: heightOf(k, height, tall), floorArea: no, perimeter: no };
  }
  const [x0, x1, z0, z1] = extentOf(footprint);
  const plan = [width, depth];
  return {
    width: measurement(x1 - x0, "m", ["room"], withScale(k, [width]), { bound: width.bound, direct: true }),
    depth: measurement(z1 - z0, "m", ["room"], withScale(k, [depth]), { bound: depth.bound, direct: true }),
    height: heightOf(k, height, tall),
    floorArea: measurement(polygonArea(footprint), "m²", ["room", "floor"], withScale(k, plan), { bound: growing(plan) }),
    perimeter: measurement(perimeterOf(footprint), "m", ["room"], withScale(k, plan), { bound: growing(plan) }),
  };
}

function heightOf(k: Knowledge, height: number, input: MeasuredInput): Measured {
  if (!(Number.isFinite(height) && height > 0)) return unavailable("the room has no height");
  return measurement(height, "m", ["room", "ceiling"], withScale(k, [input]), { bound: input.bound, direct: true });
}

/**
 * The bound of a quantity that grows with each of its inputs (an area, a
 * perimeter): at least its value when some input is a lower bound and every
 * other is a value found in the photograph; otherwise nothing is claimed.
 */
export function growing(inputs: readonly MeasuredInput[]): Bound {
  if (inputs.some((i) => i.edited || i.bound === "typical" || i.basis === "default")) return "value";
  return inputs.some((i) => i.bound === "at-least") ? "at-least" : "value";
}
