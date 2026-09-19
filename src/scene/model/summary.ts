import { roomBounds, usedMaterialIds } from "./queries";
import type { Scene, SceneProvenance } from "./types";

/**
 * What the system "understands" about a scene, reduced to what a person can
 * read at a glance. Always derived from the Scene itself, never typed in by
 * hand, so a number on screen can't drift from what's being rendered.
 */
export interface SceneSummary {
  provenance: SceneProvenance;
  roomLabel: string;
  dimensions: { width: number; depth: number; height: number };
  objects: number;
  surfaces: number;
  inferredSurfaces: number;
  lightSources: number;
  windows: number;
  doors: number;
  materials: number;
  relationships: number;
}

export function summarizeScene(scene: Scene): SceneSummary {
  const bounds = roomBounds(scene);
  return {
    provenance: scene.provenance,
    roomLabel: scene.room.label,
    dimensions: {
      width: bounds.max[0] - bounds.min[0],
      depth: bounds.max[2] - bounds.min[2],
      height: scene.room.height,
    },
    objects: scene.objects.length,
    surfaces: scene.surfaces.length,
    inferredSurfaces: scene.surfaces.filter((s) => s.evidence === "inferred").length,
    lightSources: scene.lights.filter((l) => l.kind !== "ambient").length,
    windows: scene.openings.filter((o) => o.kind === "window").length,
    doors: scene.openings.filter((o) => o.kind === "door").length,
    materials: usedMaterialIds(scene).size,
    relationships: scene.relationships.length,
  };
}

/** Metres, formatted the way an architect would dimension a drawing. */
export const formatMetres = (value: number) => `${value.toFixed(2)} m`;
