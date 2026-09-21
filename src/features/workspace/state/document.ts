import { applyOperation, invertOperation, type SceneOperation } from "@/scene/model/operations";
import type { Scene } from "@/scene/model/types";

/**
 * The workspace document: a scene, and the edits that got it there.
 *
 * History is a list of operations and their inverses rather than a list of
 * scene copies, so undo genuinely reverses what the person did. Each entry
 * carries the inverses computed against the scene as it stood *before* the
 * operations ran, which is the only moment the previous values are known.
 *
 * One entry can hold several operations, because some single acts are
 * several changes: taking away a table takes away what was standing on it.
 * Their inverses are applied in reverse, so the table comes back before the
 * vase that stood on it does.
 */

export interface Edit {
  operations: readonly SceneOperation[];
  inverses: readonly SceneOperation[];
  /** What the person did, in their words. */
  label: string;
  /**
   * Continuous gestures (a drag, a slider) arrive as a stream of edits.
   * Consecutive ones sharing a key collapse into a single entry, so an undo
   * steps back over the whole gesture rather than one frame of it.
   */
  mergeKey?: string;
}

export interface WorkspaceDocument {
  name: string;
  scene: Scene;
  past: readonly Edit[];
  future: readonly Edit[];
}

/** Deep enough for a working session; bounded so memory cannot run away. */
const HISTORY_LIMIT = 120;

export function createDocument(scene: Scene, name: string): WorkspaceDocument {
  return { name, scene, past: [], future: [] };
}

export const canUndo = (doc: WorkspaceDocument) => doc.past.length > 0;
export const canRedo = (doc: WorkspaceDocument) => doc.future.length > 0;

/**
 * Apply operations and record them as one edit. Returns the document
 * unchanged when nothing actually moved, so a drag that ends where it
 * started leaves nothing behind to undo.
 */
export function commit(
  doc: WorkspaceDocument,
  operations: readonly SceneOperation[],
  label: string,
  mergeKey?: string,
): WorkspaceDocument {
  let scene = doc.scene;
  const inverses: SceneOperation[] = [];
  for (const operation of operations) {
    // Each inverse is read against the scene that operation is about to
    // change, not against the one the whole edit started from.
    const inverse = invertOperation(scene, operation);
    const next = applyOperation(scene, operation);
    if (next === scene || !inverse) continue;
    inverses.push(inverse);
    scene = next;
  }
  if (scene === doc.scene) return doc;
  inverses.reverse();

  const last = doc.past[doc.past.length - 1];
  if (mergeKey && last?.mergeKey === mergeKey) {
    // Keep the gesture's original starting point as what undo returns to.
    const merged: Edit = { operations, inverses: last.inverses, label, mergeKey };
    return { ...doc, scene, past: [...doc.past.slice(0, -1), merged], future: [] };
  }

  const past = [...doc.past, { operations, inverses, label, mergeKey }];
  return {
    ...doc,
    scene,
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    future: [],
  };
}

/** End the current gesture, so the next edit starts a new history entry. */
export function seal(doc: WorkspaceDocument): WorkspaceDocument {
  const last = doc.past[doc.past.length - 1];
  if (!last?.mergeKey) return doc;
  const sealed: Edit = { operations: last.operations, inverses: last.inverses, label: last.label };
  return { ...doc, past: [...doc.past.slice(0, -1), sealed] };
}

export function undo(doc: WorkspaceDocument): WorkspaceDocument {
  const edit = doc.past[doc.past.length - 1];
  if (!edit) return doc;
  return {
    ...doc,
    scene: edit.inverses.reduce(applyOperation, doc.scene),
    past: doc.past.slice(0, -1),
    future: [edit, ...doc.future],
  };
}

export function redo(doc: WorkspaceDocument): WorkspaceDocument {
  const [edit, ...rest] = doc.future;
  if (!edit) return doc;
  return {
    ...doc,
    scene: edit.operations.reduce(applyOperation, doc.scene),
    // The scene is back where it was when this edit was first made, so the
    // inverses recorded then are still the right way back.
    past: [...doc.past, { ...edit, mergeKey: undefined }],
    future: rest,
  };
}
