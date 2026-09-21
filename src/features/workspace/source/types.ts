/**
 * Where the room in front of you came from.
 * ================================================================
 *
 * There are two sources, and they are never the same thing:
 *
 *   DEMO       the hand-authored demonstration Scene, opened on purpose
 *   PHOTOGRAPH an image the person brought, held in this browser
 *
 * A photograph does not become a Scene until a reconstruction pipeline
 * turns it into one. None exists yet, so `reconstructing` and
 * `reconstructed` are declared here and never reached: the state machine
 * says what the product will do without the product pretending to do it.
 * Nothing in this file, and nothing that reads it, may show the demo room
 * as though it came from someone's photograph.
 */

export interface Photograph {
  id: string;
  name: string;
  type: string;
  bytes: number;
  width: number;
  height: number;
  /** ISO timestamp, so a held photograph can say how long it has been held. */
  addedAt: string;
}

/**
 * What was actually measured from the image, in this browser. Every figure
 * here is read off the pixels; none of it is inference about the room.
 */
export interface Analysis {
  megapixels: number;
  aspect: number;
  /** Mean relative luminance across the sampled image, 0..1. */
  luminance: number;
  /** The 2nd and 98th percentile luminance: the usable tonal range. */
  range: [number, number];
  /** Colours genuinely present, most common first, with their share. */
  tones: { color: string; share: number }[];
  /** How many pixels the sample was reduced to before counting. */
  sampled: number;
}

/** The real work of taking an image in, in the order it happens. */
export const ANALYSIS_STEPS = [
  "Reading the file",
  "Decoding the image",
  "Measuring",
  "Sampling tone and colour",
] as const;

/**
 * What reconstruction will do, and does not do yet. Listed so the state
 * after analysis can be specific about what is missing rather than vague.
 */
export const RECONSTRUCTION_STAGES = [
  "Depth, read from the single image",
  "Walls, floor and openings, fitted to the depth",
  "Objects, separated and measured",
  "Materials and light, estimated from the pixels",
] as const;

export type Problem = "type" | "size" | "unreadable" | "small" | "storage";

export type SourceState =
  | { status: "empty" }
  /** The file is being read; nothing is known about it yet. */
  | { status: "uploading"; name: string; step: number }
  /** Decoded and measured, but not yet sampled. Hydrated visits land here. */
  | { status: "uploaded"; photograph: Photograph }
  /** Being measured and sampled. The image is already on screen. */
  | { status: "analyzing"; name: string; step: number }
  | { status: "ready"; photograph: Photograph; analysis: Analysis }
  /** Not reached in this build: no pipeline is connected. */
  | { status: "reconstructing"; photograph: Photograph; step: number }
  /** Not reached in this build: nothing produces a Scene from an image. */
  | { status: "reconstructed"; photograph: Photograph; sceneId: string }
  | { status: "error"; problem: Problem; name?: string };

/** Named once, from the states themselves, so the two cannot drift. */
export type SourceStatus = SourceState["status"];

/** Which of the named phases a step belongs to. */
export const phaseOf = (step: number): "uploading" | "analyzing" =>
  step <= 1 ? "uploading" : "analyzing";
