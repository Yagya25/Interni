/**
 * SceneCompiler: ReconstructionIntermediate (what the worker observed) →
 * Scene (the existing contract) + SceneEvidence (how each number is known)
 * + CompileReport (every decision taken). Pure and deterministic, so it runs
 * the same in the browser, in Node and in tests.
 */
export { compileRoomShell, COMPILER_VERSION, type CompileOptions } from "./compileRoomShell";
export { parseCalibration, solveScale, type CalibrationFile, type CalibrationReference } from "./calibration";
export type { CompileReport, CompileResult, EntityEvidence, SceneEvidence, Side } from "./evidence";
export { parseIntermediate, type Basis, type ParsedRun, type Problem, type Quantity, type ReconstructionIntermediate } from "./intermediate";
export { PRIORS } from "./priors";
