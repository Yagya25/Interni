import type { SceneEvidence } from "@/scene/compile/evidence";
import type { Id, Scene } from "@/scene/model/types";
import { measureFloor, type FloorMeasurements } from "./floor";
import { measureObjects, type ObjectMeasurements } from "./objects";
import { measureOpenings, type OpeningMeasurements } from "./openings";
import { knowledgeOf } from "./provenance";
import { measureRoom, type RoomMeasurements } from "./room";
import { MEASURE_VERSION } from "./types";
import { walkwayTo, type Walkway } from "./walkways";

/**
 * Measurement & spatial intelligence.
 * ================================================================
 *
 *   Scene (+ the compiler's evidence) → measureScene → room, floor, pieces,
 *   openings → answer(question) → a measurement or a verdict, in words
 *
 * Read-only and deterministic: the Scene stays the one source of truth, and
 * nothing here writes to it or keeps a copy of the room. Every number is
 * derived from the Scene as it now is — the room being looked at, so a
 * previewed design is measured as that design — and carries how it is known
 * (see `types.ts`). Measurements are derived on demand and never stored.
 */

export interface SceneMeasurements {
  version: typeof MEASURE_VERSION;
  sceneId: Id;
  /** Where the Scene's numbers come from: a reconstruction with evidence, or none (the demonstration room). */
  source: "reconstruction" | "authored";
  /** The scale every reconstructed length shares, when the Scene has evidence. */
  scale: { basis: "estimated" | "calibrated"; references: number; logSigma: number | null } | null;
  room: RoomMeasurements;
  floor: FloorMeasurements;
  objects: readonly ObjectMeasurements[];
  openings: readonly OpeningMeasurements[];
}

/** Measure a Scene, without caching: the same Scene and evidence always give the same result. */
export function computeMeasurements(scene: Scene, evidence?: SceneEvidence | null): SceneMeasurements {
  const k = knowledgeOf(scene, evidence);
  return {
    version: MEASURE_VERSION,
    sceneId: scene.id,
    source: k.evidence ? "reconstruction" : "authored",
    scale: k.evidence ? { basis: k.evidence.scale.basis, references: k.evidence.scale.references.length, logSigma: k.evidence.scale.logSigma } : null,
    room: measureRoom(k),
    floor: measureFloor(k),
    objects: measureObjects(k),
    openings: measureOpenings(k),
  };
}

const NO_EVIDENCE = {};
const memo = new WeakMap<Scene, WeakMap<object, SceneMeasurements>>();
const walkMemo = new WeakMap<Scene, WeakMap<object, Map<Id, Walkway>>>();

/** Measure a Scene, once per Scene object and evidence: a rendered scene is a new object whenever it changes. */
export function measureScene(scene: Scene, evidence?: SceneEvidence | null): SceneMeasurements {
  const key = evidence ?? NO_EVIDENCE;
  let byEvidence = memo.get(scene);
  if (!byEvidence) memo.set(scene, (byEvidence = new WeakMap()));
  let result = byEvidence.get(key);
  if (!result) byEvidence.set(key, (result = computeMeasurements(scene, evidence)));
  return result;
}

/** The way from a doorway to one piece, once per Scene object, evidence and piece. */
export function measureWalkway(scene: Scene, evidence: SceneEvidence | null | undefined, objectId: Id): Walkway {
  const key = evidence ?? NO_EVIDENCE;
  let byEvidence = walkMemo.get(scene);
  if (!byEvidence) walkMemo.set(scene, (byEvidence = new WeakMap()));
  let byObject = byEvidence.get(key);
  if (!byObject) byEvidence.set(key, (byObject = new Map()));
  let result = byObject.get(objectId);
  if (!result) byObject.set(objectId, (result = walkwayTo(knowledgeOf(scene, evidence), objectId)));
  return result;
}
