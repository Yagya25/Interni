import type { Material } from "@/scene/model/types";

/**
 * Material library for the demonstration room and its reimagined variant.
 * Each scene lists only the materials it uses (see `pick`).
 */
const library = {
  // Architecture
  "paint-white": { class: "paint", name: "Matte paint, chalk white", color: "#ebe7df", roughness: 0.92, metalness: 0, pattern: "plaster", patternScale: 2.4 },
  "paint-warm": { class: "paint", name: "Matte paint, warm white", color: "#ece3d4", roughness: 0.92, metalness: 0, pattern: "plaster", patternScale: 2.4 },
  "limewash-sand": { class: "paint", name: "Limewash, sand", color: "#d2c0a6", roughness: 0.95, metalness: 0, pattern: "limewash", patternScale: 3 },
  "oak-floor": { class: "wood", name: "White oak, natural oil", color: "#c9a57c", roughness: 0.55, metalness: 0, pattern: "planks", patternScale: 2.4 },
  "oak-smoked": { class: "wood", name: "Smoked oak, chevron", color: "#7a5a40", roughness: 0.5, metalness: 0, pattern: "chevron", patternScale: 1.6 },
  "frame-white": { class: "paint", name: "Painted timber, white", color: "#f1eee9", roughness: 0.6, metalness: 0, pattern: "none" },
  "steel-black": { class: "metal", name: "Powder-coated steel, black", color: "#262523", roughness: 0.42, metalness: 0.65, pattern: "none" },
  "glass-clear": { class: "glass", name: "Clear glass", color: "#dfe6e6", roughness: 0.04, metalness: 0, pattern: "none", opacity: 0.12 },

  // Furniture
  "linen-oat": { class: "fabric", name: "Washed linen, oat", color: "#cbbfa9", roughness: 0.95, metalness: 0, pattern: "weave", patternScale: 0.35 },
  "linen-moss": { class: "fabric", name: "Washed linen, moss", color: "#6c6a4c", roughness: 0.95, metalness: 0, pattern: "weave", patternScale: 0.35 },
  "boucle-ivory": { class: "fabric", name: "Bouclé, ivory", color: "#e6ded0", roughness: 1, metalness: 0, pattern: "boucle", patternScale: 0.3 },
  "wool-rug": { class: "fabric", name: "Flatweave wool", color: "#b9ad98", roughness: 1, metalness: 0, pattern: "weave", patternScale: 0.8 },
  "jute": { class: "fabric", name: "Jute", color: "#b39a74", roughness: 1, metalness: 0, pattern: "jute", patternScale: 0.6 },
  "linen-sheer": { class: "fabric", name: "Linen voile", color: "#efe8dc", roughness: 1, metalness: 0, pattern: "weave", patternScale: 0.3, opacity: 0.82 },
  "leather-cognac": { class: "leather", name: "Aniline leather, cognac", color: "#8a5634", roughness: 0.55, metalness: 0, pattern: "none" },
  "walnut": { class: "wood", name: "American walnut", color: "#5b4030", roughness: 0.5, metalness: 0, pattern: "grain", patternScale: 0.8 },
  "marble": { class: "stone", name: "Carrara marble, honed", color: "#e3e0da", roughness: 0.3, metalness: 0, pattern: "veined", patternScale: 1.2 },
  "travertine": { class: "stone", name: "Travertine, filled", color: "#d6c6ab", roughness: 0.6, metalness: 0, pattern: "travertine", patternScale: 1 },
  "ceramic-white": { class: "ceramic", name: "Glazed ceramic", color: "#ece8e0", roughness: 0.25, metalness: 0, pattern: "none" },
  "terracotta": { class: "ceramic", name: "Terracotta", color: "#a8674a", roughness: 0.85, metalness: 0, pattern: "none" },
  "linen-shade": { class: "fabric", name: "Linen shade", color: "#e9e1d2", roughness: 1, metalness: 0, pattern: "weave", patternScale: 0.2, emissive: "#ffcf95" },
  "paper-washi": { class: "paper", name: "Washi paper", color: "#f1ebdf", roughness: 1, metalness: 0, pattern: "none", emissive: "#ffd6a0" },
  "print-paper": { class: "paper", name: "Archival print", color: "#ece6da", roughness: 0.9, metalness: 0, pattern: "canvas", patternScale: 1 },
  "canvas-earth": { class: "paper", name: "Painted canvas", color: "#b9936a", roughness: 0.95, metalness: 0, pattern: "canvas", patternScale: 1.5 },
  "book-covers": { class: "paper", name: "Cloth-bound covers", color: "#8f7d66", roughness: 0.85, metalness: 0, pattern: "none" },
  "leaf": { class: "plant", name: "Foliage", color: "#4d5a3a", roughness: 0.7, metalness: 0, pattern: "none" },
  "leaf-olive": { class: "plant", name: "Olive foliage", color: "#7d8466", roughness: 0.75, metalness: 0, pattern: "none" },
} satisfies Record<string, Omit<Material, "id">>;

export type DemoMaterialId = keyof typeof library;

export function pick(...ids: DemoMaterialId[]): Material[] {
  return ids.map((id) => ({ id, ...library[id] }) as Material);
}

export function demoMaterial(id: DemoMaterialId): Material {
  return { id, ...library[id] } as Material;
}

/**
 * Everything in the library, for a palette to choose from. A reconstructed
 * room will bring its own estimated materials; until then this stands in
 * for the finishes a person can reach for.
 */
export const demoLibrary: Material[] = (Object.keys(library) as DemoMaterialId[]).map(demoMaterial);
