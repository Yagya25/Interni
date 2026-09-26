/**
 * Measurement & spatial intelligence: the engine (`scene.ts`), its
 * measurements, and the questions answered from them.
 */

export { computeMeasurements, measureScene, measureWalkway, type SceneMeasurements } from "./scene";
export { distanceBetween } from "./distance";
export { basisOf, describeMeasurement, digits, formatMeasurement, formatSeries } from "./format";
export type { FloorMeasurements } from "./floor";
export { clearAround, sizeOf, type EndedBy, type Face, type Fact, type ObjectMeasurements } from "./objects";
export type { OpeningMeasurements } from "./openings";
export { knowledgeOf, type Knowledge } from "./provenance";
export { answer, type SpatialAnswer, type SpatialQuestion } from "./questions";
export type { RoomMeasurements } from "./room";
export { atLeast, MEASURE_VERSION, type Bound, type Measured, type MeasuredInput, type Measurement, type Unavailable, type Verdict } from "./types";
export { WALKWAY, walkwayTo, type Walkway } from "./walkways";
