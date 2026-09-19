import type { Id, Material, SceneObject, Vec3 } from "./types";

/**
 * Edits to a scene, expressed as data. The editor will produce these from
 * direct manipulation; an AI redesign can produce them as a plan. The
 * renderer can preview any operation partially applied (0..1).
 */
export type SceneOperation =
  | { kind: "move"; objectId: Id; to: Vec3; rotationY: number }
  | { kind: "replace"; objectId: Id; replacement: SceneObject }
  | { kind: "restyle"; objectId: Id; slot: string; to: Material };

export type OperationKind = SceneOperation["kind"];

export function findOperation<K extends OperationKind>(
  operations: readonly SceneOperation[],
  kind: K,
): Extract<SceneOperation, { kind: K }> | undefined {
  return operations.find((op): op is Extract<SceneOperation, { kind: K }> => op.kind === kind);
}
