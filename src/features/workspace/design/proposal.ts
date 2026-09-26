import type { SceneOperation } from "@/scene/model/operations";
import type { Id } from "@/scene/model/types";
import type { ProposedChange } from "../ai/interpreter";
import type { LayoutSummary } from "./layout/report";
import type { DesignStyle } from "./styles";

/**
 * A design proposal: a plan, not a change.
 * ================================================================
 *
 * A proposal holds the operations it *would* make and nothing more. It is
 * not a Scene, not a picture and not a mutation — until the person applies
 * it, the room it describes exists only as this list. Applying one hands
 * those very operations to the workspace's history, so a design arrives in
 * the room through exactly the machinery a drag does.
 *
 * `status` is the proposal's place in that life: drafted, previewed in the
 * room, applied to the document, or set aside.
 *
 * A proposal may carry finishes, light, a layout, or finishes and a layout
 * together; they are all operations in the one list, so preview, apply and
 * undo treat a moved sofa and a repainted wall the same way.
 */

export type ProposalStatus = "draft" | "preview" | "applied" | "rejected";

export interface ProposalPreview {
  operationCount: number;
  changedObjectCount: number;
  changedMaterialCount: number;
  changedLightCount: number;
  /** Pieces the proposal moves or turns. */
  movedObjectCount: number;
  /** Pieces whose finishes the proposal recolours. */
  restyledObjectCount: number;
}

export interface DesignProposal {
  /** Stable for a given style and variant, so the same request names the same proposal. */
  id: string;
  title: string;
  /** The finish style, or null for a proposal that only rearranges the furniture. */
  style: DesignStyle | null;
  /** Which reading this is: "warm", "neutral", "dark-accent"; a layout's "facing", "around", "open". */
  variant: string;
  description: string;
  designGoals: readonly string[];
  /** The whole plan, in the order it would be applied. */
  operations: readonly SceneOperation[];
  affectedObjects: readonly Id[];
  affectedMaterials: readonly Id[];
  affectedLighting: readonly Id[];
  /** Why this room gets this treatment, read from its own analysis. */
  rationale: readonly string[];
  /** What the proposal deliberately does not touch. */
  constraints: readonly string[];
  /**
   * The same grouped shape a command proposal uses, so the workspace can
   * show a design's changes with the parts it already has.
   */
  changes: readonly ProposedChange[];
  preview: ProposalPreview;
  status: ProposalStatus;
  /** What the proposal's layout does to the room as a whole, when it has one. */
  layout: LayoutSummary | null;
}

/** Why a proposal was not offered, in the person's terms. */
export interface RejectedProposal {
  id: string;
  title: string;
  reason: string;
}

export const previewOf = (operations: readonly SceneOperation[]): ProposalPreview => ({
  operationCount: operations.length,
  changedObjectCount: distinct(operations.flatMap((op) => ("objectId" in op ? [op.objectId] : []))).length,
  changedMaterialCount: distinct(operations.flatMap((op) => (op.kind === "restyle" || op.kind === "resurface" ? [op.to.id] : []))).length,
  changedLightCount: distinct(operations.flatMap((op) => (op.kind === "relight" ? [op.lightId] : []))).length,
  movedObjectCount: distinct(operations.flatMap((op) => (op.kind === "move" ? [op.objectId] : []))).length,
  restyledObjectCount: distinct(operations.flatMap((op) => (op.kind === "restyle" ? [op.objectId] : []))).length,
});

/** The same proposal at another point in its life. Pure: the original is untouched. */
export const withStatus = (proposal: DesignProposal, status: ProposalStatus): DesignProposal =>
  proposal.status === status ? proposal : { ...proposal, status };

export const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];
