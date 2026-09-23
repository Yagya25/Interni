import { findById, usedMaterialIds } from "./queries";
import type { Id, Light, Material, Relationship, Scene, SceneObject, Vec3 } from "./types";

/**
 * Edits to a scene, expressed as data. Direct manipulation produces these;
 * an AI redesign can produce them as a plan. The renderer can preview any
 * operation partially applied (0..1).
 *
 * Every operation is reversible against the scene it was applied to, so a
 * history is a list of operations rather than a list of scene copies.
 */
export type SceneOperation =
  | { kind: "move"; objectId: Id; to: Vec3; rotationY: number }
  | { kind: "scale"; objectId: Id; to: Vec3 }
  | { kind: "restyle"; objectId: Id; slot: string; to: Material; library?: LibraryEntry }
  | { kind: "replace"; objectId: Id; replacement: SceneObject }
  | {
      kind: "add";
      object: SceneObject;
      index: number;
      /** What the object related to, and the light it gave, each with its place in its list. */
      relationships?: readonly { relationship: Relationship; index: number }[];
      lights?: readonly { light: Light; index: number }[];
    }
  | { kind: "remove"; objectId: Id }
  | { kind: "resurface"; surfaceId: Id; to: Material; library?: LibraryEntry }
  | { kind: "relight"; lightId: Id; to: LightChange };

export type OperationKind = SceneOperation["kind"];

/**
 * Carried by the inverse of a restyle or resurface: what the library's entry
 * of that id was before the change, or null when the change added it. Undo
 * puts it back, so a finish that was only tried does not stay behind.
 */
export interface LibraryEntry {
  id: Id;
  was: Material | null;
}

/**
 * What a `relight` changes. Only the keys present are applied, so the
 * inverse of a change is the same keys carrying their previous values.
 * `on: "auto"` returns a fixture to following the daylight;
 * `timeOfDay: "auto"` returns the daylight to the default hour, unset.
 */
export interface LightChange {
  /** Daylight only. 0 = midday through 1 = evening. */
  timeOfDay?: number | "auto";
  /** Artificial only. */
  colorTemperature?: number;
  intensity?: number;
  on?: boolean | "auto";
}

export function findOperation<K extends OperationKind>(
  operations: readonly SceneOperation[],
  kind: K,
): Extract<SceneOperation, { kind: K }> | undefined {
  return operations.find((op): op is Extract<SceneOperation, { kind: K }> => op.kind === kind);
}

/** Objects this one physically carries, and the ones those carry. */
export function carriedBy(scene: Scene, objectId: Id): SceneObject[] {
  const held = scene.objects.filter(
    (o) => o.support.kind === "object" && o.support.objectId === objectId,
  );
  return held.flatMap((o) => [...carriedBy(scene, o.id), o]);
}

/**
 * Move a piece to `to`, turned to `rotationY`, together with everything it
 * carries. Positions in a scene are absolute, so a sofa moved on its own
 * would leave its cushions in the air; instead the load keeps its place on
 * the piece, sliding with it and turning about its centre. One act, so the
 * operations travel and undo together.
 */
export function moveWithLoad(scene: Scene, object: SceneObject, to: Vec3, rotationY: number): SceneOperation[] {
  const [fx, fy, fz] = object.transform.position;
  const turn = rotationY - object.transform.rotation[1];
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const load = carriedBy(scene, object.id).map((held): SceneOperation => {
    const [hx, hy, hz] = held.transform.position;
    const dx = hx - fx;
    const dz = hz - fz;
    return {
      kind: "move",
      objectId: held.id,
      // The offset from the carrier, turned about +Y with it.
      to: [to[0] + dx * cos + dz * sin, hy + (to[1] - fy), to[2] - dx * sin + dz * cos],
      rotationY: held.transform.rotation[1] + turn,
    };
  });
  return [{ kind: "move", objectId: object.id, to, rotationY }, ...load];
}

// ---------------------------------------------------------------------------
// Applying

/**
 * Apply one operation. Pure: the scene passed in is never touched, and
 * everything the operation does not reach keeps its identity, so a renderer
 * can tell what changed by comparing references.
 */
export function applyOperation(scene: Scene, operation: SceneOperation): Scene {
  switch (operation.kind) {
    case "move":
      return withObject(scene, operation.objectId, (object) =>
        sameVec(object.transform.position, operation.to) &&
        object.transform.rotation[1] === operation.rotationY
          ? object
          : {
              ...object,
              transform: {
                ...object.transform,
                position: operation.to,
                rotation: [
                  object.transform.rotation[0],
                  operation.rotationY,
                  object.transform.rotation[2],
                ],
              },
            },
      );

    case "scale":
      return withObject(scene, operation.objectId, (object) =>
        sameVec(object.transform.scale, operation.to)
          ? object
          : { ...object, transform: { ...object.transform, scale: operation.to } },
      );

    case "restyle": {
      const next = withObject(scene, operation.objectId, (object) =>
        object.materials[operation.slot] === operation.to.id
          ? object
          : { ...object, materials: { ...object.materials, [operation.slot]: operation.to.id } },
      );
      return withEntry(withMaterial(next, operation.to), operation.library);
    }

    case "replace": {
      const index = scene.objects.findIndex((o) => o.id === operation.objectId);
      if (index < 0) return scene;
      const objects = [...scene.objects];
      objects[index] = operation.replacement;
      return { ...scene, objects };
    }

    case "add": {
      if (findById(scene.objects, operation.object.id)) return scene;
      const objects = [...scene.objects];
      objects.splice(clampIndex(operation.index, objects.length), 0, operation.object);
      // Anything the object was known to relate to comes back with it, and so
      // does the light a lamp gives.
      // Each back where it was in its list, so an undo leaves the scene exactly as it found it.
      const relationships = insertAt(scene.relationships, (operation.relationships ?? []).map((r) => ({ item: r.relationship, index: r.index })));
      const lights = insertAt(scene.lights, (operation.lights ?? []).map((l) => ({ item: l.light, index: l.index })));
      return { ...scene, objects, relationships, lights };
    }

    case "remove": {
      if (!findById(scene.objects, operation.objectId)) return scene;
      const gone = (l: Light) => l.kind === "artificial" && l.fixtureId === operation.objectId;
      return {
        ...scene,
        objects: scene.objects.filter((o) => o.id !== operation.objectId),
        // An object that carried others takes them with it.
        relationships: scene.relationships.filter(
          (r) => r.subjectId !== operation.objectId && r.objectId !== operation.objectId,
        ),
        // A lamp that is taken away takes its light: no light is left without a fixture.
        lights: scene.lights.some(gone) ? scene.lights.filter((l) => !gone(l)) : scene.lights,
      };
    }

    case "resurface": {
      const surface = findById(scene.surfaces, operation.surfaceId);
      if (!surface) return scene;
      const next: Scene =
        surface.materialId === operation.to.id
          ? scene
          : {
              ...scene,
              surfaces: scene.surfaces.map((s) =>
                s.id === operation.surfaceId ? { ...s, materialId: operation.to.id } : s,
              ),
            };
      return withEntry(withMaterial(next, operation.to), operation.library);
    }

    case "relight": {
      const light = findById(scene.lights, operation.lightId);
      if (!light) return scene;
      const next = relit(light, operation.to);
      if (sameLight(light, next)) return scene;
      return { ...scene, lights: scene.lights.map((l) => (l.id === operation.lightId ? next : l)) };
    }
  }
}

export function applyOperations(scene: Scene, operations: readonly SceneOperation[]): Scene {
  return operations.reduce(applyOperation, scene);
}

/**
 * The operation that undoes `operation`, read from the scene as it stands
 * *before* the operation is applied. Returns null when the operation would
 * not change this scene at all.
 */
export function invertOperation(scene: Scene, operation: SceneOperation): SceneOperation | null {
  switch (operation.kind) {
    case "move": {
      const object = findById(scene.objects, operation.objectId);
      if (!object) return null;
      return {
        kind: "move",
        objectId: object.id,
        to: object.transform.position,
        rotationY: object.transform.rotation[1],
      };
    }

    case "scale": {
      const object = findById(scene.objects, operation.objectId);
      if (!object) return null;
      return { kind: "scale", objectId: object.id, to: object.transform.scale };
    }

    case "restyle": {
      const object = findById(scene.objects, operation.objectId);
      const previous = object && findById(scene.materials, object.materials[operation.slot] ?? "");
      if (!object || !previous) return null;
      const library = entryBefore(scene, operation.to, previous);
      return { kind: "restyle", objectId: object.id, slot: operation.slot, to: previous, ...(library && { library }) };
    }

    case "replace": {
      const object = findById(scene.objects, operation.objectId);
      if (!object) return null;
      return { kind: "replace", objectId: operation.replacement.id, replacement: object };
    }

    case "add":
      return findById(scene.objects, operation.object.id)
        ? null
        : { kind: "remove", objectId: operation.object.id };

    case "remove": {
      const index = scene.objects.findIndex((o) => o.id === operation.objectId);
      if (index < 0) return null;
      return {
        kind: "add",
        object: scene.objects[index],
        index,
        // Removing an object drops what the model knew about it; putting it
        // back has to put that knowledge back too.
        relationships: scene.relationships.flatMap((relationship, at) =>
          relationship.subjectId === operation.objectId || relationship.objectId === operation.objectId
            ? [{ relationship, index: at }]
            : [],
        ),
        lights: scene.lights.flatMap((light, at) =>
          light.kind === "artificial" && light.fixtureId === operation.objectId ? [{ light, index: at }] : [],
        ),
      };
    }

    case "resurface": {
      const surface = findById(scene.surfaces, operation.surfaceId);
      const previous = surface && findById(scene.materials, surface.materialId);
      if (!surface || !previous) return null;
      const library = entryBefore(scene, operation.to, previous);
      return { kind: "resurface", surfaceId: surface.id, to: previous, ...(library && { library }) };
    }

    case "relight": {
      const light = findById(scene.lights, operation.lightId);
      if (!light) return null;
      const to: LightChange = {};
      if (operation.to.timeOfDay !== undefined && light.kind === "daylight") {
        // An hour nobody set goes back to being unset, not to the default written down.
        to.timeOfDay = light.timeOfDay ?? "auto";
      }
      if (light.kind === "artificial") {
        if (operation.to.colorTemperature !== undefined) to.colorTemperature = light.colorTemperature;
        if (operation.to.intensity !== undefined) to.intensity = light.intensity ?? 1;
        if (operation.to.on !== undefined) to.on = light.on === undefined ? "auto" : light.on;
      }
      return Object.keys(to).length ? { kind: "relight", lightId: light.id, to } : null;
    }
  }
}

/** Where a scene's daylight sits when nothing has set it. */
export const DEFAULT_TIME_OF_DAY = 0.18;

/** The scene's time of day, which the renderer's light rig is driven by. */
export function timeOfDay(scene: Scene): number {
  const daylight = scene.lights.find((l) => l.kind === "daylight");
  return daylight?.timeOfDay ?? DEFAULT_TIME_OF_DAY;
}

/**
 * The hour in words, midday through night. Beside the hour's own meaning,
 * so a command and a design proposal cannot name the same hour differently.
 */
export const hourName = (t: number) =>
  t < 0.12 ? "midday" : t < 0.35 ? "early afternoon" : t < 0.6 ? "late afternoon" : t < 0.8 ? "evening" : "night";

// ---------------------------------------------------------------------------
// Internals

/**
 * An operation that asks for what is already true changes nothing, and
 * says so by returning the very same scene.
 *
 * This is not only tidiness. A drag held against a wall asks for the same
 * clamped position every frame; without this the document would gain an
 * edit, the renderer a diff, and undo a step that does nothing.
 */
function withObject(scene: Scene, id: Id, change: (object: SceneObject) => SceneObject): Scene {
  const object = findById(scene.objects, id);
  if (!object) return scene;
  const next = change(object);
  if (next === object) return scene;
  return { ...scene, objects: scene.objects.map((o) => (o.id === id ? next : o)) };
}

const sameVec = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

function sameLight(a: Light, b: Light) {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === "daylight" && b.kind === "daylight") return a.timeOfDay === b.timeOfDay;
  if (a.kind === "artificial" && b.kind === "artificial") {
    return (
      a.colorTemperature === b.colorTemperature && a.intensity === b.intensity && a.on === b.on
    );
  }
  return true;
}

/**
 * Add a material to the scene's library, or replace the entry of that id.
 *
 * A restyle writes its finish into the library; its inverse carries the
 * entry as it was before (`LibraryEntry`), so undo takes a finish that was
 * only tried back out and the scene returns exactly to what it was.
 */
function withMaterial(scene: Scene, material: Material): Scene {
  const existing = findById(scene.materials, material.id);
  // Equal in every field is unchanged: a number field that applies its value
  // while typing and again on Enter must not leave an undo step that does nothing.
  if (existing && sameMaterial(existing, material)) return scene;
  return {
    ...scene,
    materials: existing
      ? scene.materials.map((m) => (m.id === material.id ? material : m))
      : [...scene.materials, material],
  };
}

/**
 * The library entry a finish change overwrites, when it overwrites one: the
 * id of the new finish, and what stood under that id before (null when the
 * change adds it). Undefined when the change leaves the library's other
 * entries as they were — the new finish is the old one re-edited, or is
 * already in the library exactly as given.
 */
function entryBefore(scene: Scene, to: Material, previous: Material): LibraryEntry | undefined {
  if (to.id === previous.id) return undefined;
  const existing = findById(scene.materials, to.id);
  if (existing && sameMaterial(existing, to)) return undefined;
  return { id: to.id, was: existing ?? null };
}

/** Put a library entry back as it was, dropping it if it was not there and nothing uses it. */
function withEntry(scene: Scene, entry: LibraryEntry | undefined): Scene {
  if (!entry) return scene;
  if (entry.was) return withMaterial(scene, entry.was);
  if (!findById(scene.materials, entry.id) || usedMaterialIds(scene).has(entry.id)) return scene;
  return { ...scene, materials: scene.materials.filter((m) => m.id !== entry.id) };
}

function sameMaterial(a: Material, b: Material) {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Material>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function relit(light: Light, change: LightChange): Light {
  if (light.kind === "daylight") {
    if (change.timeOfDay === undefined) return light;
    if (change.timeOfDay !== "auto") return { ...light, timeOfDay: change.timeOfDay };
    const next = { ...light };
    delete next.timeOfDay;
    return next;
  }
  if (light.kind !== "artificial") return light;
  const next = { ...light };
  if (change.colorTemperature !== undefined) next.colorTemperature = change.colorTemperature;
  // `intensity: 1` and an absent switch both mean "as the model found it",
  // so returning either to that drops the override rather than writing it
  // down. One representation of "unchanged" keeps a relight exactly
  // reversible: undo leaves the light as it was, not as an equal value.
  if (change.intensity !== undefined) {
    if (change.intensity === 1) delete next.intensity;
    else next.intensity = change.intensity;
  }
  if (change.on !== undefined) {
    if (change.on === "auto") delete next.on;
    else next.on = change.on;
  }
  return next;
}

const clampIndex = (index: number, length: number) => Math.min(Math.max(index, 0), length);

/** Put items back at their indices (lowest first), skipping any whose id is already there. */
function insertAt<T extends { id: Id }>(list: readonly T[], items: readonly { item: T; index: number }[]): readonly T[] {
  const missing = items.filter(({ item }) => !findById(list, item.id));
  if (missing.length === 0) return list;
  const next = [...list];
  for (const { item, index } of [...missing].sort((a, b) => a.index - b.index)) next.splice(clampIndex(index, next.length), 0, item);
  return next;
}
