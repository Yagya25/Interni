/**
 * Scene contract
 * ==============
 * The structured representation of a physical room. Today a Scene comes from
 * the hand-authored demonstration library; later it will come from the
 * reconstruction pipeline (depth, segmentation, layout, material and light
 * estimation). Everything downstream (renderer, editor, AI redesign, floor
 * plan, camera studio) reads this shape and nothing else.
 *
 * Conventions
 * - Units are metres.
 * - Right-handed coordinates, +Y up, floor at y = 0.
 * - Rotations are XYZ Euler angles in radians.
 * - Colours are sRGB hex strings.
 * - Every entity has a stable `id`, so a design variant can say
 *   "this sofa moved" rather than "a sofa appeared".
 */

export type Id = string;
export type Vec2 = readonly [x: number, z: number];
export type Vec3 = readonly [x: number, y: number, z: number];
export type Hex = `#${string}`;

// ---------------------------------------------------------------------------
// Scene

export interface Scene {
  schemaVersion: 1;
  id: Id;
  provenance: SceneProvenance;
  room: Room;
  /** Estimated pose of the camera that took the source photograph. */
  camera: CaptureCamera;
  surfaces: readonly Surface[];
  openings: readonly Opening[];
  objects: readonly SceneObject[];
  materials: readonly Material[];
  lights: readonly Light[];
  relationships: readonly Relationship[];
}

/**
 * Where a scene came from. UI must use this to label scenes honestly:
 * a demo scene is never presented as the output of an analysis.
 */
export type SceneProvenance =
  | { kind: "demo"; description: string }
  | {
      kind: "reconstruction";
      sourceImageId: Id;
      pipelineVersion: string;
      createdAt: string;
    };

// ---------------------------------------------------------------------------
// Room and architecture

export type RoomType =
  | "living-room"
  | "bedroom"
  | "kitchen"
  | "dining-room"
  | "office"
  | "bathroom"
  | "other";

export interface Room {
  type: RoomType;
  label: string;
  /** Floor outline on the XZ plane. */
  footprint: readonly Vec2[];
  height: number;
}

export interface CaptureCamera {
  position: Vec3;
  target: Vec3;
  /** Vertical field of view in degrees. */
  verticalFov: number;
  /** Width / height of the source image. */
  aspect: number;
}

/**
 * Whether a surface was seen in the photograph or completed by inference.
 * Surfaces outside the frame (behind the camera, beyond the edge) are
 * inferred and should be presented as such.
 */
export type Evidence = "observed" | "inferred";

interface SurfaceBase {
  id: Id;
  label: string;
  materialId: Id;
  evidence: Evidence;
}

/** Floor and ceiling span the room footprint. */
export interface PlaneSurface extends SurfaceBase {
  kind: "floor" | "ceiling";
}

export interface WallSurface extends SurfaceBase {
  kind: "wall";
  /** Base line of the wall's interior face on the floor plane. */
  start: Vec2;
  end: Vec2;
  thickness: number;
}

export type Surface = PlaneSurface | WallSurface;
export type SurfaceKind = Surface["kind"];

export interface Opening {
  id: Id;
  kind: "window" | "door";
  label: string;
  wallId: Id;
  /** Distance from the wall's start point to the opening's centre line. */
  offset: number;
  width: number;
  height: number;
  /** Height of the opening's bottom edge above the floor. */
  sill: number;
  frameMaterialId: Id;
  /** Glass for windows, leaf for doors. */
  panelMaterialId: Id;
}

// ---------------------------------------------------------------------------
// Objects

export type ObjectCategory =
  | "sofa"
  | "armchair"
  | "lounge-chair"
  | "coffee-table"
  | "side-table"
  | "sideboard"
  | "media-console"
  | "television"
  | "bookshelf"
  | "rug"
  | "floor-lamp"
  | "pendant-lamp"
  | "plant"
  | "artwork"
  | "vase"
  | "books"
  | "cushion"
  | "ottoman"
  | "basket"
  | "curtain"
  | "bench";

export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

/** What physically carries the object. Drives placement and editing rules. */
export type Support =
  | { kind: "floor" }
  | { kind: "wall"; wallId: Id }
  | { kind: "ceiling" }
  | { kind: "object"; objectId: Id };

export interface SceneObject {
  id: Id;
  category: ObjectCategory;
  label: string;
  /** Origin is the centre of the object's base. */
  transform: Transform;
  /** Extent in the object's local frame: width (X), height (Y), depth (Z). */
  dimensions: Vec3;
  /** Named material slots, e.g. { frame: "walnut", upholstery: "linen-oat" }. */
  materials: Readonly<Record<string, Id>>;
  support: Support;
  /** Form descriptor a renderer can use to choose a representation. */
  form?: string;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

// ---------------------------------------------------------------------------
// Materials

export type MaterialClass =
  | "wood"
  | "fabric"
  | "stone"
  | "glass"
  | "metal"
  | "paint"
  | "ceramic"
  | "paper"
  | "leather"
  | "plant";

/** Procedural surface pattern hint. Real pipelines will attach textures. */
export type SurfacePattern =
  | "none"
  | "planks"
  | "chevron"
  | "grain"
  | "weave"
  | "boucle"
  | "veined"
  | "travertine"
  | "limewash"
  | "plaster"
  | "jute"
  | "canvas";

export interface Material {
  id: Id;
  class: MaterialClass;
  name: string;
  color: Hex;
  roughness: number;
  metalness: number;
  pattern: SurfacePattern;
  /** Physical size of one pattern repeat, in metres. */
  patternScale?: number;
  opacity?: number;
  /** Self-illumination, e.g. a lamp shade or the sky seen through glass. */
  emissive?: Hex;
}

// ---------------------------------------------------------------------------
// Light

interface LightBase {
  id: Id;
  label: string;
}

export interface DaylightSource extends LightBase {
  kind: "daylight";
  openingIds: readonly Id[];
}

export interface AmbientLight extends LightBase {
  kind: "ambient";
  color: Hex;
}

export interface ArtificialLight extends LightBase {
  kind: "artificial";
  /** The object that emits the light. */
  fixtureId: Id;
  /** Position of the emitter relative to the fixture's origin. */
  emitterOffset: Vec3;
  colorTemperature: number;
}

export type Light = DaylightSource | AmbientLight | ArtificialLight;

// ---------------------------------------------------------------------------
// Relationships

export type RelationPredicate =
  | "faces"
  | "beside"
  | "in-front-of"
  | "on"
  | "under"
  | "above"
  | "against"
  | "lit-by"
  | "opposite";

export interface Relationship {
  id: Id;
  subjectId: Id;
  predicate: RelationPredicate;
  objectId: Id;
}

// ---------------------------------------------------------------------------
// Design

/**
 * A complete alternative arrangement of the same physical room. Objects that
 * keep their `id` are the same object, moved or restyled; new ids are
 * additions; missing ids are removals.
 */
export interface DesignVariant {
  id: Id;
  name: string;
  summary: string;
  baseSceneId: Id;
  scene: Scene;
}
