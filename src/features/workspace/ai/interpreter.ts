import type { SceneOperation } from "@/scene/model/operations";
import type { Id, Scene } from "@/scene/model/types";

/**
 * The boundary a language model will sit behind.
 * ================================================================
 *
 * The workspace never asks anything to "do" something to the room. It asks
 * for an *interpretation*: scene operations it can preview, show, and apply
 * or discard, exactly like an edit made by hand.
 *
 *   SceneCommand → CommandInterpreter → CommandIntent → ProposedChange[]
 *                                                             ↓
 *                                                 preview → apply → history
 *
 * Everything downstream of the interpreter is the same machinery a drag
 * goes through, so whatever replaces the interpreter inherits undo,
 * preview and the renderer for free.
 *
 * An interpreter describes itself, and the interface makes it say *how* it
 * reads a command. A rule-based reader normalises wording and matches a
 * known set of intents; a model reads language. The workspace shows which
 * one is answering rather than letting a person assume.
 */

/** What the person asked, with the context needed to resolve words like "this". */
export interface SceneCommand {
  text: string;
  /** The object in focus when the command was written, if any. */
  subjectId: Id | null;
  /** The scene the command is about. */
  scene: Scene;
}

/**
 * What a command was understood to ask for, before it is planned against the
 * scene. A model would produce the same shape, which is why it is spelled out
 * rather than left implicit in a parser.
 */
export interface CommandIntent {
  intent: IntentKind;
  /** Who or what the command is about, as it was named. */
  target: IntentTarget;
  /** The verb, normalised: "darken", "rotate", "move-closer", "replace". */
  action: string;
  /** Everything else the command specified, keyed by meaning. */
  parameters: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  /** 0..1: how directly the words named this intent. */
  confidence: number;
  /** Set when the command cannot be carried out without asking something. */
  clarificationRequired: Clarification | null;
}

export type IntentKind =
  | "tone"
  | "recolour"
  | "warmth"
  | "brightness"
  | "size"
  | "rotate"
  | "move"
  | "switch"
  | "replace"
  | "reset"
  | "unavailable";

export type IntentTarget =
  | { kind: "room" }
  /** "this", "that", "it", "the selected one": whatever is selected. */
  | { kind: "selection"; word: string }
  /** The words before any relation, to be looked up in the scene. */
  | { kind: "named"; phrase: string }
  | { kind: "unspecified" };

export type Clarification =
  | { reason: "no-selection" }
  | { reason: "ambiguous"; options: readonly string[] }
  | { reason: "no-target" }
  | { reason: "no-reference" };

/** One proposed change: what it touches, what it does, and how. */
export interface ProposedChange {
  id: string;
  /** Which part of the room it belongs to, for grouping: "Lighting", "Materials". */
  group: string;
  /** The thing being changed, e.g. "Walls" or "Floor lamp". */
  target: string;
  /** The change itself, e.g. "a warmer neutral". */
  detail: string;
  /** Often one; several when a single change reaches several entities. */
  operations: readonly SceneOperation[];
}

export interface Interpretation {
  /** The command this answers, kept so the proposal can be read on its own. */
  command: string;
  summary: string;
  changes: readonly ProposedChange[];
  intent: CommandIntent;
}

/**
 * A request the interpreter understood but this build cannot carry out,
 * kept as structured data so the capability that eventually fulfils it
 * (asset retrieval, a model) receives exactly what was asked.
 */
export interface ReplacementRequest {
  kind: "replace-object";
  targetObjectId: Id;
  targetLabel: string;
  /** The form asked for, as the person put it: "L-shaped". */
  requestedForm: string;
  /** Anything else asked of it: colour, material, size words. */
  requestedAttributes: readonly string[];
}

/**
 * Four honest answers: here is what I would change; I understood but can't
 * do that yet; I need you to tell me something first; I couldn't turn that
 * into an edit at all.
 */
export type InterpretationResult =
  | { outcome: "changes"; interpretation: Interpretation }
  | { outcome: "unavailable"; message: string; command: string; intent: CommandIntent; request?: ReplacementRequest }
  | { outcome: "clarify"; message: string; intent: CommandIntent }
  | { outcome: "unsupported"; message: string };

export interface CommandInterpreter {
  readonly name: string;
  /**
   * `rules` normalises wording and matches a known set of intents; it
   * understands nothing outside them. `model` reads language. The difference
   * is shown to the person, because it changes what they can expect.
   */
  readonly kind: "rules" | "model";
  /** One line on what this interpreter is, in plain words. */
  readonly note: string;
  /** Requests it genuinely handles, listed from the rules themselves. */
  readonly examples: readonly string[];
  readonly available: boolean;
  /** Why it cannot be used, when `available` is false. */
  readonly unavailableReason?: string;
  interpret(command: SceneCommand, signal: AbortSignal): Promise<InterpretationResult>;
}

/** No interpreter at all: the command bar refuses and says so. */
export const notConnected: CommandInterpreter = {
  name: "None",
  kind: "model",
  note: "No interpreter is connected to this workspace.",
  examples: [],
  available: false,
  unavailableReason:
    "Reading a sentence as a change to your room needs an interpreter, and none is connected here.",
  interpret() {
    return Promise.reject(new Error("No interpreter is connected."));
  },
};
