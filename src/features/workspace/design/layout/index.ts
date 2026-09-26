/**
 * Spatial design: layouts of the furniture a room already has.
 *
 *   Scene → analyseLayout → LayoutIntent → planLayouts → move operations
 *         → validateLayout → part of a DesignProposal
 *
 * Deterministic and pure. Nothing here draws a room or mutates one: a layout
 * is a list of ordinary `move` operations for existing pieces, which the
 * design engine offers and the workspace's history applies.
 */

export { analyseLayout, LAYOUT_ANALYSIS_VERSION, type LayoutAnalysis, type PieceFacts } from "./analysis";
export { circulationOf, CIRCULATION, type Circulation } from "./circulation";
export { PASSAGE, passageZones, relationsOf } from "./geometry";
export { layoutAxes, layoutIntentOf, LAYOUT_AXES, LAYOUT_STYLES, type LayoutAxis, type LayoutIntent, type LayoutStyle } from "./intent";
export { planLayouts, type LayoutResult, type PlannedLayout } from "./layouts";
export { PLANNER, type LayoutPlan } from "./planner";
export { isLayoutRequest, readLayout, type LayoutRead } from "./read";
export type { LayoutReport, LayoutSummary } from "./report";
export { primarySeat, ROLES_VERSION, spatialRoles, type Mobility, type SpatialRole, type SpatialRoleType } from "./roles";
export { READINGS } from "./strategies";
export { validateLayout, type LayoutCheck } from "./validate";
