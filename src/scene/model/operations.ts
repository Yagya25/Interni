import { findById } from "./queries";
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
  | { kind: "restyle"; objectId: Id; slot: string; to: Material }
  | { kind: "replace"; objectId: Id; replacement: SceneObject }
  | { kind: "add"; object: SceneObject; index: number; relationships?: readonly Relationship[] }
  | { kind: "remove"; objectId: Id }
  | { kind: "resurface"; surfaceId: Id; to: Material }
  | { kind: "relight"; lightId: Id; to: LightChange };

export type OperationKind = SceneOperation["kind"];

/**
 * What a `relight` changes. Only the keys present are applied, so the
 * inverse of a change is the same keys carrying their previous values.
 * `on: "auto"` returns a fixture to following the daylight.
 */
export interface LightChange {
  /** Daylight only. 0 = midday through 1 = evening. */
  timeOfDay?: number;
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
      return withMaterial(next, operation.to);
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
      // Anything the object was known to relate to comes back with it.
      const restored = (operation.relationships ?? []).filter((r) => !findById(scene.relationships, r.id));
      return {
        ...scene,
        objects,
        relationships: restored.length ? [...scene.relationships, ...restored] : scene.relationships,
      };
    }

    case "remove": {
      if (!findById(scene.objects, operation.objectId)) return scene;
      return {
        ...scene,
        objects: scene.objects.filter((o) => o.id !== operation.objectId),
        // An object that carried others takes them with it.
        relationships: scene.relationships.filter(
          (r) => r.subjectId !== operation.objectId && r.objectId !== operation.objectId,
        ),
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
      return withMaterial(next, operation.to);
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
      return { kind: "restyle", objectId: object.id, slot: operation.slot, to: previous };
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
        relationships: scene.relationships.filter(
          (r) => r.subjectId === operation.objectId || r.objectId === operation.objectId,
        ),
      };
    }

    case "resurface": {
      const surface = findById(scene.surfaces, operation.surfaceId);
      const previous = surface && findById(scene.materials, surface.materialId);
      if (!surface || !previous) return null;
      return { kind: "resurface", surfaceId: surface.id, to: previous };
    }

    case "relight": {
      const light = findById(scene.lights, operation.lightId);
      if (!light) return null;
      const to: LightChange = {};
      if (operation.to.timeOfDay !== undefined && light.kind === "daylight") {
        to.timeOfDay = light.timeOfDay ?? DEFAULT_TIME_OF_DAY;
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
 * The library is a library: a finish that stops being used stays in it, so
 * undoing a restyle leaves the material that was tried behind. Nothing
 * counts it — `usedMaterialIds` is what the summary and the renderer read —
 * and keeping it is what makes a restyle exactly reversible, because the
 * entry an inverse needs is always still there.
 */
function withMaterial(scene: Scene, material: Material): Scene {
  const existing = findById(scene.materials, material.id);
  if (existing === material) return scene;
  return {
    ...scene,
    materials: existing
      ? scene.materials.map((m) => (m.id === material.id ? material : m))
      : [...scene.materials, material],
  };
}

function relit(light: Light, change: LightChange): Light {
  if (light.kind === "daylight") {
    return change.timeOfDay === undefined ? light : { ...light, timeOfDay: change.timeOfDay };
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
