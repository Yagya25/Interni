import type { SceneOperation } from "@/scene/model/operations";
import { summarizeScene } from "@/scene/model/summary";
import type { MaterialClass, Vec3 } from "@/scene/model/types";
import { livingRoom, place } from "./livingRoom";
import { livingRoomReimagined } from "./livingRoomReimagined";
import { demoMaterial } from "./materials";

/**
 * Single source for everything the landing page demonstrates.
 *
 * When reconstruction exists, `scene` is replaced by a pipeline result and
 * `variant` by an AI redesign. The landing page reads nothing else, and
 * every number it shows is derived from these objects.
 */

/** Edits performed in the "Now it can change" chapter, as scene operations. */
const operations: SceneOperation[] = [
  { kind: "move", objectId: "coffee-table", to: [-0.3, 0, -0.32], rotationY: 0.16 },
  {
    kind: "replace",
    objectId: "armchair",
    replacement: {
      id: "armchair-alt",
      category: "lounge-chair",
      label: "Lounge chair",
      form: "sling",
      transform: place([-2.05, 0, 0.75], 2.2),
      dimensions: [0.72, 0.74, 0.82],
      materials: { seat: "leather-cognac", frame: "walnut" },
      support: { kind: "floor" },
    },
  },
  { kind: "restyle", objectId: "sofa", slot: "upholstery", to: demoMaterial("linen-moss") },
];

/**
 * Where each material class is called out in the materials chapter. The
 * anchor is both where the label sits and where the reveal spreads from.
 */
export interface MaterialCallout {
  class: MaterialClass;
  label: string;
  detail: string;
  anchor: Vec3;
}

const materialCallouts: MaterialCallout[] = [
  { class: "wood", label: "Wood", detail: "White oak, oiled", anchor: [1.1, 0, -0.6] },
  { class: "fabric", label: "Fabric", detail: "Washed linen", anchor: [-0.3, 0.46, -1.75] },
  { class: "stone", label: "Stone", detail: "Carrara marble", anchor: [-0.55, 0.39, -0.62] },
  { class: "glass", label: "Glass", detail: "Clear glazing", anchor: [-3, 1.5, 1.05] },
  { class: "metal", label: "Metal", detail: "Powder-coated steel", anchor: [-0.7, 2.05, -0.6] },
  { class: "leather", label: "Leather", detail: "Aniline, cognac", anchor: [-2.0, 0.55, 0.75] },
  { class: "paint", label: "Paint", detail: "Matte, chalk white", anchor: [0.4, 1.9, -2.4] },
];

export const demo = {
  scene: livingRoom,
  summary: summarizeScene(livingRoom),
  variant: livingRoomReimagined,
  operations,
  materialCallouts,
} as const;

export type Demo = typeof demo;
