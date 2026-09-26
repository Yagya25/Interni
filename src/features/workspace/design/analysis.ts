import { channels, luminance, warmth } from "@/scene/model/colour";
import { DEFAULT_TIME_OF_DAY } from "@/scene/model/operations";
import { findById, roomBounds, walls } from "@/scene/model/queries";
import type {
  ArtificialLight,
  Hex,
  Id,
  MaterialClass,
  ObjectCategory,
  RoomType,
  Scene,
  SceneObject,
} from "@/scene/model/types";
import { analyseLayout, type LayoutAnalysis } from "./layout/analysis";

/**
 * What this room actually is.
 * ================================================================
 *
 * Read from the Scene and from nothing else: every number below traces to
 * a surface, an object, a material or a light the room holds. Where the
 * Scene is silent the analysis is silent too — there is no inference layer
 * here, and nothing is filled in from a prior.
 *
 * Deterministic: the same Scene always gives the same analysis, field for
 * field, so two identical requests cannot produce different proposals.
 */

export const ANALYSIS_VERSION = "design-analysis-0.2";

export interface SurfaceFinish {
  surfaceId: Id;
  label: string;
  materialId: Id;
  class: MaterialClass;
  color: Hex;
  name: string;
}

export interface SlotFinish {
  objectId: Id;
  label: string;
  category: ObjectCategory;
  slot: string;
  materialId: Id;
  class: MaterialClass;
  color: Hex;
  /** True when the finish is a stand-in the photograph never showed. */
  unestimated: boolean;
}

export interface DesignAnalysis {
  version: typeof ANALYSIS_VERSION;
  sceneId: Id;
  room: {
    type: RoomType;
    label: string;
    width: number;
    depth: number;
    height: number;
    /** Plan area of the footprint's bounding rectangle, m². */
    floorArea: number;
  };
  furniture: {
    count: number;
    /** Every category present, most numerous first, then alphabetical. */
    categories: readonly { category: ObjectCategory; count: number }[];
    /** Plan area the floor-standing pieces take up, m². */
    occupiedArea: number;
    freeArea: number;
    /** Occupied over floor area, 0..1. */
    density: number;
    seating: readonly Id[];
    /** What the room is arranged around, when one piece plainly is it. */
    focal: Id | null;
    wallMounted: readonly Id[];
    floorStanding: readonly Id[];
    /** Pieces standing on other pieces. */
    carried: readonly Id[];
    largest: Id | null;
  };
  materials: {
    walls: readonly SurfaceFinish[];
    floor: SurfaceFinish | null;
    ceiling: SurfaceFinish | null;
    /** Every object finish a design could touch, in scene order. */
    slots: readonly SlotFinish[];
    /** The colours that cover the most of the room, most used first. */
    palette: readonly { color: Hex; class: MaterialClass; uses: number }[];
    /** Mean lightness of the room's surfaces and finishes, 0..1. */
    lightness: number;
    /** Lightest minus darkest, 0..1. */
    contrast: number;
    /** Mean saturation, 0..1: low is a neutral room. */
    saturation: number;
  };
  lighting: {
    /** The hour the room is set to, 0 = midday … 1 = night. */
    hour: number;
    daylight: { id: Id; openingIds: readonly Id[]; direct: boolean | null } | null;
    ambient: { id: Id; color: Hex } | null;
    lamps: readonly { id: Id; fixtureId: Id; label: string; colorTemperature: number; intensity: number; on: boolean | null }[];
    /** Lamps the room has but has not switched on. */
    unlit: readonly Id[];
  };
  spatialConstraints: {
    /** Pieces the room put against a wall; a design must not pull them off it. */
    againstWall: readonly { objectId: Id; wallId: Id }[];
    carried: readonly { objectId: Id; carrierId: Id }[];
    openings: readonly { id: Id; wallId: Id; kind: "window" | "door" }[];
    relationshipCount: number;
  };
  /** Where the room already sits on the style axes, −1 to 1 (contrast 0..1). */
  existingStyleSignals: {
    warmth: number;
    brightness: number;
    contrast: number;
    /** 0 = entirely neutral, 1 = fully saturated. */
    colourfulness: number;
    woodPresent: boolean;
    fabricPresent: boolean;
  };
  /**
   * The room as a plan: roles, footprints, clearances, relationships as the
   * geometry now holds them, and whether a person can get round it. What a
   * layout is planned from.
   */
  layout: LayoutAnalysis;
}

const SEATING: readonly ObjectCategory[] = ["sofa", "armchair", "lounge-chair", "chair", "bench", "ottoman"];
/** What a room is arranged around, when it holds one: the first of these that is present. */
const FOCAL: readonly ObjectCategory[] = ["television", "sofa"];

export function analyseScene(scene: Scene): DesignAnalysis {
  const bounds = roomBounds(scene);
  const width = round(bounds.max[0] - bounds.min[0], 0.001);
  const depth = round(bounds.max[2] - bounds.min[2], 0.001);
  const floorArea = round(width * depth, 0.001);

  const floorStanding = scene.objects.filter((o) => o.support.kind === "floor");
  const occupiedArea = round(floorStanding.reduce((sum, o) => sum + planArea(o), 0), 0.001);

  const counts = new Map<ObjectCategory, number>();
  for (const object of scene.objects) counts.set(object.category, (counts.get(object.category) ?? 0) + 1);

  const surface = (kind: "floor" | "ceiling") => {
    const found = scene.surfaces.find((s) => s.kind === kind);
    return found ? finishOf(scene, found.id, found.label, found.materialId) : null;
  };

  const slots: SlotFinish[] = scene.objects.flatMap((object) =>
    Object.entries(object.materials)
      .map(([slot, materialId]) => {
        const material = findById(scene.materials, materialId);
        if (!material) return null;
        return {
          objectId: object.id,
          label: object.label,
          category: object.category,
          slot,
          materialId,
          class: material.class,
          color: material.color,
          unestimated: materialId.startsWith("unestimated"),
        } satisfies SlotFinish;
      })
      .filter((s): s is SlotFinish => s !== null),
  );

  const wallFinishes = walls(scene).map((wall) => finishOf(scene, wall.id, wall.label, wall.materialId)!);
  const floor = surface("floor");
  const ceiling = surface("ceiling");
  const covering = [...wallFinishes, ...(floor ? [floor] : []), ...(ceiling ? [ceiling] : []), ...slots];

  const lightnesses = covering.map((c) => luminance(c.color));
  const daylight = scene.lights.find((l) => l.kind === "daylight");
  const ambient = scene.lights.find((l) => l.kind === "ambient");
  const lamps = scene.lights.filter((l): l is ArtificialLight => l.kind === "artificial");

  const palette = [...tally(covering.map((c) => `${c.color}|${c.class}`)).entries()]
    .map(([key, uses]) => {
      const [color, cls] = key.split("|");
      return { color: color as Hex, class: cls as MaterialClass, uses };
    })
    .sort((a, b) => b.uses - a.uses || a.color.localeCompare(b.color));

  const saturation = mean(covering.map((c) => saturationOf(c.color)));
  const lightness = mean(lightnesses);

  return {
    version: ANALYSIS_VERSION,
    sceneId: scene.id,
    room: { type: scene.room.type, label: scene.room.label, width, depth, height: round(scene.room.height, 0.001), floorArea },
    furniture: {
      count: scene.objects.length,
      categories: [...counts.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      occupiedArea,
      freeArea: round(Math.max(0, floorArea - occupiedArea), 0.001),
      density: round(floorArea > 0 ? Math.min(1, occupiedArea / floorArea) : 0, 0.001),
      seating: scene.objects.filter((o) => SEATING.includes(o.category)).map((o) => o.id),
      focal: focalOf(scene),
      wallMounted: scene.objects.filter((o) => o.support.kind === "wall").map((o) => o.id),
      floorStanding: floorStanding.map((o) => o.id),
      carried: scene.objects.filter((o) => o.support.kind === "object").map((o) => o.id),
      largest: largestOf(floorStanding),
    },
    materials: {
      walls: wallFinishes,
      floor,
      ceiling,
      slots,
      palette,
      lightness: round(lightness, 0.001),
      contrast: round(lightnesses.length ? Math.max(...lightnesses) - Math.min(...lightnesses) : 0, 0.001),
      saturation: round(saturation, 0.001),
    },
    lighting: {
      hour: daylight?.kind === "daylight" ? (daylight.timeOfDay ?? DEFAULT_TIME_OF_DAY) : DEFAULT_TIME_OF_DAY,
      daylight: daylight?.kind === "daylight" ? { id: daylight.id, openingIds: daylight.openingIds, direct: daylight.direct ?? null } : null,
      ambient: ambient?.kind === "ambient" ? { id: ambient.id, color: ambient.color } : null,
      lamps: lamps.map((lamp) => ({
        id: lamp.id,
        fixtureId: lamp.fixtureId,
        label: findById(scene.objects, lamp.fixtureId)?.label ?? lamp.label,
        colorTemperature: lamp.colorTemperature,
        intensity: lamp.intensity ?? 1,
        on: lamp.on ?? null,
      })),
      unlit: lamps.filter((lamp) => lamp.on !== true).map((lamp) => lamp.id),
    },
    spatialConstraints: {
      againstWall: scene.relationships
        .filter((r) => r.predicate === "against" && scene.surfaces.some((s) => s.id === r.objectId && s.kind === "wall"))
        .map((r) => ({ objectId: r.subjectId, wallId: r.objectId })),
      carried: scene.objects
        .filter((o) => o.support.kind === "object")
        .map((o) => ({ objectId: o.id, carrierId: o.support.kind === "object" ? o.support.objectId : "" })),
      openings: scene.openings.map((o) => ({ id: o.id, wallId: o.wallId, kind: o.kind })),
      relationshipCount: scene.relationships.length,
    },
    existingStyleSignals: {
      warmth: round(mean(covering.map((c) => warmth(c.color))), 0.001),
      brightness: round(lightness * 2 - 1, 0.001),
      contrast: round(lightnesses.length ? Math.max(...lightnesses) - Math.min(...lightnesses) : 0, 0.001),
      colourfulness: round(saturation, 0.001),
      woodPresent: covering.some((c) => c.class === "wood"),
      fabricPresent: covering.some((c) => c.class === "fabric" || c.class === "leather"),
    },
    layout: analyseLayout(scene),
  };
}

function finishOf(scene: Scene, surfaceId: Id, label: string, materialId: Id): SurfaceFinish | null {
  const material = findById(scene.materials, materialId);
  if (!material) return null;
  return { surfaceId, label, materialId, class: material.class, color: material.color, name: material.name };
}

/** The piece the room reads as arranged around: a television, else the sofa, else nothing. */
function focalOf(scene: Scene): Id | null {
  for (const category of FOCAL) {
    const found = scene.objects.find((o) => o.category === category);
    if (found) return found.id;
  }
  return null;
}

function largestOf(objects: readonly SceneObject[]): Id | null {
  let largest: SceneObject | null = null;
  for (const object of objects) if (!largest || planArea(object) > planArea(largest)) largest = object;
  return largest?.id ?? null;
}

const planArea = (o: SceneObject) => o.dimensions[0] * o.transform.scale[0] * o.dimensions[2] * o.transform.scale[2];

function saturationOf(hex: string) {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
}

function tally(keys: readonly string[]) {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

const mean = (values: readonly number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const round = (value: number, step: number) => {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(value / step) * step).toFixed(decimals));
};
