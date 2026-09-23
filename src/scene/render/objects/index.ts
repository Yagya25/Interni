import type { ObjectCategory } from "@/scene/model/types";
import { block } from "../geometry";
import { group, part, type ObjectBuilder } from "./common";
import { artwork, basket, books, curtain, plant, rug, vase } from "./decor";
import { floorLamp, pendantLamp } from "./fixtures";
import { bed, bookshelf, cabinet, chair, desk, diningTable, mediaConsole, television } from "./furniture";
import { armchair, bench, cushions, loungeChair, ottoman, sofa } from "./seating";
import { coffeeTable, sideTable } from "./tables";

export type { BuildContext, ObjectBuilder } from "./common";

/**
 * Any category without a dedicated builder renders as its bounding volume.
 * A reconstruction result can therefore always be displayed, even for
 * objects this renderer has never seen.
 */
const boundingVolume: ObjectBuilder = ({ object, material }) => {
  const [w, h, d] = object.dimensions;
  const slot = Object.keys(object.materials)[0];
  return group(part(block(w, h, d, 0.02), material(slot, { sectionCaps: true })));
};

const builders: Partial<Record<ObjectCategory, ObjectBuilder>> = {
  sofa,
  armchair,
  "lounge-chair": loungeChair,
  ottoman,
  bench,
  cushion: cushions,
  "coffee-table": coffeeTable,
  "side-table": sideTable,
  "floor-lamp": floorLamp,
  "pendant-lamp": pendantLamp,
  rug,
  plant,
  artwork,
  vase,
  books,
  basket,
  curtain,
  chair,
  "dining-table": diningTable,
  desk,
  cabinet,
  bed,
  television,
  "media-console": mediaConsole,
  bookshelf,
};

export const builderFor = (category: ObjectCategory): ObjectBuilder => builders[category] ?? boundingVolume;
