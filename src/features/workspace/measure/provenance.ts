import type { EntityEvidence, SceneEvidence } from "@/scene/compile/evidence";
import type { Quantity } from "@/scene/compile/intermediate";
import { roomBounds } from "@/scene/model/queries";
import type { Id, Opening, Scene, SceneObject, WallSurface } from "@/scene/model/types";
import type { Bound, MeasuredInput } from "./types";

/**
 * How each Scene value is known *now*.
 * ================================================================
 *
 * The compiler's evidence describes the room as it was reconstructed. The
 * Scene may since have been edited — a piece moved, resized, a layout
 * applied, a design previewed — and a value that no longer matches its
 * evidence describes the design, not the photograph. Each input says which.
 *
 * Nothing is guessed: a value is `edited` only when it differs from the
 * value the evidence recorded, by more than the millimetre the compiler
 * rounds to; a lower bound is a lower bound only where the evidence says
 * so; and a Scene with no evidence (the demonstration room, which was
 * authored rather than measured) is `default` throughout.
 */

export interface Knowledge {
  scene: Scene;
  /** The compiler's evidence for this Scene, or null when it has none. */
  evidence: SceneEvidence | null;
}

/** Evidence belongs to one Scene; a sidecar for another is no evidence for this one. */
export function knowledgeOf(scene: Scene, evidence?: SceneEvidence | null): Knowledge {
  return { scene, evidence: evidence && evidence.sceneId === scene.id ? evidence : null };
}

/** The compiler rounds every length to the millimetre; anything further off was edited. */
const SAME = 0.0015;
/** Turns are recorded in degrees, to 0.01°. */
const SAME_DEG = 0.02;

const differs = (a: number, b: number, tolerance = SAME) => !(Math.abs(a - b) <= tolerance);

/** A value nothing measured: the demonstration room's authored numbers, or a reconstruction's missing record. */
function unmeasured(k: Knowledge, id: Id, field: string, why: "authored" | "not-reconstructed" | "replaced" | "no-record"): MeasuredInput {
  const source = k.scene.provenance.kind === "demo" ? "demo:authored" : `scene:${why}`;
  return { id, field, basis: "default", sources: [source], edited: why === "not-reconstructed" || why === "replaced", bound: "value", sigma: null };
}

function fromQuantity(id: Id, field: string, q: Quantity<unknown>, edited: boolean, bound: Bound): MeasuredInput {
  return { id, field, basis: q.basis, sources: q.sources, edited, bound: edited ? "value" : bound, sigma: edited ? null : q.sigma };
}

/**
 * The scale every length shares. Every reconstructed length already carries
 * its basis; the scale is listed too, so a measurement says what its lengths
 * were scaled by.
 */
export function scaleInput(k: Knowledge): MeasuredInput | null {
  if (!k.evidence) return null;
  const { scale } = k.evidence;
  const sources = scale.basis === "calibrated" ? [`calibration:${scale.references.length} reference${scale.references.length === 1 ? "" : "s"}`] : ["scale:depth-model"];
  return { id: "scale", field: "factor", basis: scale.basis, sources, edited: false, bound: "value", sigma: null };
}

// ---------------------------------------------------------------------------
// Room

export type RoomField = "width" | "depth" | "height";

export function roomInput(k: Knowledge, field: RoomField): MeasuredInput {
  const entity = k.evidence?.entities.room;
  const q = entity?.fields[field];
  if (!q) return unmeasured(k, "room", field, k.scene.provenance.kind === "demo" ? "authored" : "no-record");
  const b = roomBounds(k.scene);
  const now = field === "width" ? b.max[0] - b.min[0] : field === "depth" ? b.max[2] - b.min[2] : k.scene.room.height;
  // An unseen side, or an unseen ceiling, is closed at the farthest point seen: the room is at least that large.
  return fromQuantity("room", field, q, differs(now, q.value as number), q.basis === "inferred" ? "at-least" : "value");
}

// ---------------------------------------------------------------------------
// Objects

export type ObjectField = "dimensions.0" | "dimensions.1" | "dimensions.2" | "transform.position" | "transform.rotation.1";

function objectEntity(k: Knowledge, object: SceneObject): EntityEvidence | "not-reconstructed" | "replaced" | null {
  if (!k.evidence) return null;
  const entity = k.evidence.entities[object.id];
  if (!entity || entity.kind !== "object") return "not-reconstructed";
  // A piece swapped for another is not the piece in the photograph, whatever its id.
  if (entity.fields.category && entity.fields.category.value !== object.category) return "replaced";
  return entity;
}

export function objectInput(k: Knowledge, object: SceneObject, field: ObjectField): MeasuredInput {
  const entity = objectEntity(k, object);
  if (entity === null) return unmeasured(k, object.id, field, k.scene.provenance.kind === "demo" ? "authored" : "no-record");
  if (typeof entity === "string") return unmeasured(k, object.id, field, entity);
  const q = entity.fields[field];
  if (!q) return unmeasured(k, object.id, field, "no-record");

  if (field === "transform.position") {
    const was = q.value as readonly number[];
    const edited = object.transform.position.some((v, i) => differs(v, was[i]));
    return fromQuantity(object.id, field, q, edited, "value");
  }
  if (field === "transform.rotation.1") {
    const deg = (object.transform.rotation[1] * 180) / Math.PI;
    const turned = Math.abs(((deg - (q.value as number) + 540) % 360) - 180);
    return fromQuantity(object.id, field, q, turned > SAME_DEG, "value");
  }
  const axis = Number(field.slice(-1)) as 0 | 1 | 2;
  const now = object.dimensions[axis] * object.transform.scale[axis];
  // What the compiler said of this size: seen in part (a lower bound), or a typical one for its kind.
  const bound: Bound = q.basis === "inferred" || q.basis === "default" ? "typical" : q.note?.includes("lower bound") ? "at-least" : "value";
  return fromQuantity(object.id, field, q, differs(now, q.value as number), bound);
}

/** The size inputs, width, height and depth, in that order (the Scene's own). */
export const sizeInputs = (k: Knowledge, object: SceneObject): [MeasuredInput, MeasuredInput, MeasuredInput] => [
  objectInput(k, object, "dimensions.0"),
  objectInput(k, object, "dimensions.1"),
  objectInput(k, object, "dimensions.2"),
];

/**
 * Everything a piece's footprint on the floor rests on: its width and depth
 * and where it stands — and which way it faces, when that moves it.
 *
 * The compiler turns a piece to one of the four sides of the box it saw
 * (the box's own turn is estimated from pixels); which side is the front is
 * a rule, `inferred`. The rectangle on the floor is the same whichever side
 * is called the front — unless a size was not seen and was extended behind
 * the front face, as the compiler does with a typical depth. So the turn is
 * an input only then, or once the piece has been turned by an edit.
 */
export function footprintInputs(k: Knowledge, object: SceneObject): MeasuredInput[] {
  const width = objectInput(k, object, "dimensions.0");
  const depth = objectInput(k, object, "dimensions.2");
  const turn = objectInput(k, object, "transform.rotation.1");
  const facingPlacesIt = turn.edited || [width, depth].some((i) => i.bound === "typical" || i.basis === "inferred" || i.basis === "default");
  return [width, depth, objectInput(k, object, "transform.position"), ...(facingPlacesIt ? [turn] : [])];
}

/** How it is known that a piece stands on what carries it. */
export function supportInput(k: Knowledge, object: SceneObject): MeasuredInput {
  const entity = objectEntity(k, object);
  if (entity === null) return unmeasured(k, object.id, "support", k.scene.provenance.kind === "demo" ? "authored" : "no-record");
  if (typeof entity === "string") return unmeasured(k, object.id, "support", entity);
  const q = entity.fields.support;
  if (!q) return unmeasured(k, object.id, "support", "no-record");
  return fromQuantity(object.id, "support", q, q.value !== object.support.kind, "value");
}

// ---------------------------------------------------------------------------
// Walls and openings

export function wallInput(k: Knowledge, wall: WallSurface): MeasuredInput {
  const q = k.evidence?.entities[wall.id]?.fields.position;
  if (!q) return unmeasured(k, wall.id, "position", k.scene.provenance.kind === "demo" ? "authored" : "no-record");
  // A wall is placed by the room's footprint, which nothing in the workspace edits.
  return fromQuantity(wall.id, "position", q, false, "value");
}

export type OpeningField = "width" | "height" | "sill";

export function openingInput(k: Knowledge, opening: Opening, field: OpeningField): MeasuredInput {
  const q = k.evidence?.entities[opening.id]?.fields[field];
  if (!q) return unmeasured(k, opening.id, field, k.scene.provenance.kind === "demo" ? "authored" : "no-record");
  return fromQuantity(opening.id, field, q, differs(opening[field], q.value as number), "value");
}

/** Inputs with the scale's own added, for a length or an area. */
export function withScale(k: Knowledge, inputs: readonly MeasuredInput[]): MeasuredInput[] {
  const scale = scaleInput(k);
  return scale ? [...inputs, scale] : [...inputs];
}
