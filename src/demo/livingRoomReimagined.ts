import type { DesignVariant, Opening, SceneObject, Surface } from "@/scene/model/types";
import { livingRoom, livingRoomOpenings, livingRoomSurfaces, place } from "./livingRoom";
import { pick } from "./materials";

/**
 * DEMONSTRATION VARIANT — the same room, redesigned by hand.
 *
 * Same walls, windows, door and camera. Objects that keep an id are the
 * same piece moved or restyled (sofa, table, rug, lamps, plant, art);
 * new ids are additions (lounge chairs, bench, curtains); missing ids
 * (armchair, ottoman, basket, cushions) were removed.
 */

const surfaces: Surface[] = livingRoomSurfaces.map((surface) => {
  if (surface.kind === "floor") return { ...surface, materialId: "oak-smoked" };
  if (surface.kind === "ceiling") return { ...surface, materialId: "paint-warm" };
  return { ...surface, materialId: "limewash-sand" };
});

const openings: Opening[] = livingRoomOpenings.map((opening) =>
  opening.kind === "window"
    ? { ...opening, frameMaterialId: "steel-black" }
    : { ...opening, frameMaterialId: "limewash-sand", panelMaterialId: "limewash-sand" },
);

const objects: SceneObject[] = [
  {
    id: "sofa",
    category: "sofa",
    label: "Sofa",
    form: "curved",
    transform: place([-0.8, 0, -1.72]),
    dimensions: [2.7, 0.74, 1.05],
    materials: { upholstery: "boucle-ivory", legs: "oak-smoked" },
    support: { kind: "floor" },
  },
  {
    id: "artwork",
    category: "artwork",
    label: "Artwork",
    form: "canvas",
    transform: place([-0.8, 1.1, -2.4]),
    dimensions: [1.5, 1.1, 0.045],
    materials: { frame: "oak-smoked", surface: "canvas-earth" },
    support: { kind: "wall", wallId: "wall-north" },
  },
  {
    id: "coffee-table",
    category: "coffee-table",
    label: "Coffee table",
    form: "drum",
    transform: place([-0.75, 0, -0.42]),
    dimensions: [1.0, 0.34, 1.0],
    materials: { top: "travertine", legs: "travertine" },
    support: { kind: "floor" },
  },
  {
    id: "vase",
    category: "vase",
    label: "Vase",
    form: "branches",
    transform: place([-0.92, 0.34, -0.36]),
    dimensions: [0.22, 0.62, 0.22],
    materials: { body: "terracotta", foliage: "leaf-olive" },
    support: { kind: "object", objectId: "coffee-table" },
  },
  {
    id: "books",
    category: "books",
    label: "Books",
    form: "stack",
    transform: place([-0.5, 0.34, -0.5], -0.35),
    dimensions: [0.3, 0.1, 0.22],
    materials: { cover: "book-covers" },
    support: { kind: "object", objectId: "coffee-table" },
  },
  {
    id: "rug",
    category: "rug",
    label: "Rug",
    form: "round",
    transform: place([-0.75, 0, -0.55]),
    dimensions: [3.0, 0.014, 3.0],
    materials: { pile: "jute" },
    support: { kind: "floor" },
  },
  {
    id: "lounge-chair-west",
    category: "lounge-chair",
    label: "Lounge chair",
    form: "sling",
    transform: place([-1.75, 0, 0.55], 2.45),
    dimensions: [0.72, 0.74, 0.82],
    materials: { seat: "leather-cognac", frame: "walnut" },
    support: { kind: "floor" },
  },
  {
    id: "lounge-chair-east",
    category: "lounge-chair",
    label: "Lounge chair",
    form: "sling",
    transform: place([0.5, 0, -0.2], -1.75),
    dimensions: [0.72, 0.74, 0.82],
    materials: { seat: "leather-cognac", frame: "walnut" },
    support: { kind: "floor" },
  },
  {
    id: "side-table",
    category: "side-table",
    label: "Side table",
    form: "block",
    transform: place([-2.4, 0, -1.95]),
    dimensions: [0.42, 0.46, 0.42],
    materials: { top: "travertine" },
    support: { kind: "floor" },
  },
  {
    id: "floor-lamp",
    category: "floor-lamp",
    label: "Floor lamp",
    form: "globe",
    transform: place([0.95, 0, -1.95]),
    dimensions: [0.5, 1.45, 0.5],
    materials: { shade: "paper-washi", stand: "steel-black" },
    support: { kind: "floor" },
  },
  {
    id: "pendant-lamp",
    category: "pendant-lamp",
    label: "Pendant",
    form: "lantern",
    transform: place([-0.75, 1.72, -0.45]),
    dimensions: [0.72, 1.08, 0.72],
    materials: { shade: "paper-washi", diffuser: "paper-washi" },
    support: { kind: "ceiling" },
  },
  {
    id: "plant",
    category: "plant",
    label: "Olive tree",
    form: "olive",
    transform: place([-2.55, 0, 0.05]),
    dimensions: [0.9, 2.05, 0.9],
    materials: { pot: "terracotta", foliage: "leaf-olive", stem: "walnut" },
    support: { kind: "floor" },
  },
  {
    id: "bench",
    category: "bench",
    label: "Window bench",
    form: "slatted",
    transform: place([-2.7, 0, 1.05], Math.PI / 2),
    dimensions: [1.3, 0.42, 0.38],
    materials: { top: "oak-smoked" },
    support: { kind: "floor" },
  },
  {
    id: "curtain-south",
    category: "curtain",
    label: "Curtain",
    form: "stacked",
    transform: place([-2.86, 0, 2.02], Math.PI / 2),
    dimensions: [0.46, 2.72, 0.12],
    materials: { fabric: "linen-sheer" },
    support: { kind: "wall", wallId: "wall-west" },
  },
  {
    id: "curtain-north",
    category: "curtain",
    label: "Curtain",
    form: "stacked",
    transform: place([-2.86, 0, -1.92], Math.PI / 2),
    dimensions: [0.46, 2.72, 0.12],
    materials: { fabric: "linen-sheer" },
    support: { kind: "wall", wallId: "wall-west" },
  },
];

export const livingRoomReimagined: DesignVariant = {
  id: "variant-warm-minimal",
  name: "Warm minimal",
  summary: "Seating gathered around one round table. Limewash walls, smoked oak, travertine, bouclé.",
  baseSceneId: livingRoom.id,
  scene: {
    ...livingRoom,
    id: "demo-living-room-warm-minimal",
    surfaces,
    openings,
    objects,
    materials: pick(
      "limewash-sand",
      "oak-smoked",
      "paint-warm",
      "steel-black",
      "glass-clear",
      "boucle-ivory",
      "jute",
      "linen-sheer",
      "leather-cognac",
      "walnut",
      "travertine",
      "terracotta",
      "paper-washi",
      "canvas-earth",
      "book-covers",
      "leaf-olive",
    ),
    relationships: [
      { id: "r1", subjectId: "sofa", predicate: "faces", objectId: "coffee-table" },
      { id: "r2", subjectId: "lounge-chair-west", predicate: "faces", objectId: "sofa" },
      { id: "r3", subjectId: "lounge-chair-east", predicate: "faces", objectId: "sofa" },
      { id: "r4", subjectId: "rug", predicate: "under", objectId: "coffee-table" },
      { id: "r5", subjectId: "pendant-lamp", predicate: "above", objectId: "coffee-table" },
      { id: "r6", subjectId: "bench", predicate: "under", objectId: "window-south" },
      { id: "r7", subjectId: "artwork", predicate: "above", objectId: "sofa" },
    ],
  },
};
