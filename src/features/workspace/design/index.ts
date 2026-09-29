/**
 * The design proposal engine.
 *
 *   Scene → DesignAnalysis → DesignIntent → DesignProposal[] → preview → apply
 *
 * A proposal is finishes and light, a layout of the furniture the room
 * already has (`layout/`), or both. Everything here is deterministic and
 * pure. The engine proposes; the workspace's existing history applies.
 * Nothing in it renders, and nothing in it mutates a Scene.
 */

export { analyseScene, ANALYSIS_VERSION, type DesignAnalysis, type SlotFinish, type SurfaceFinish } from "./analysis";
export { generateProposals, type GenerationResult } from "./generate";
export { axesOf, DESIGN_INTENT_VERSION, MAX_VARIANTS, validateDesignIntent, type DesignIntent, type ValidatedIntent } from "./intent";
export { MESSAGES as DESIGN_MESSAGES } from "./messages";
export { previewOf, withStatus, type DesignProposal, type ProposalPreview, type ProposalStatus, type RejectedProposal } from "./proposal";
export { designRules, readBrief, readDesignRequest, type DesignIntentProvider, type DesignRequest } from "./read";
export { applied, fromIntent, previewing, proposalAt, proposalOf, readDesigns, type DesignOutcome, type DesignSession, type DirectionCheck, type DirectionCheckResult } from "./session";
export { resolveScheme, STYLES, STYLE_ORDER, styleFor, type DesignScheme, type DesignStyle, type StyleAxes, type StylePreset, type StyleVariant } from "./styles";
export { validateOperations, type ProposalCheck } from "./validate";
export {
  analyseLayout,
  circulationOf,
  LAYOUT_STYLES,
  planLayouts,
  spatialRoles,
  validateLayout,
  type Circulation,
  type LayoutAnalysis,
  type LayoutIntent,
  type LayoutStyle,
  type LayoutSummary,
  type SpatialRole,
} from "./layout";
