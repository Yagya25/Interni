import type { SceneOperation } from "@/scene/model/operations";
import type { Id, Scene } from "@/scene/model/types";
import type { StructuredCommand } from "./command";
import type { SceneIntent } from "./intent";

/**
 * The boundary a language model will sit behind.
 * ================================================================
 *
 * The workspace never asks anything to "do" something to the room. It asks
 * for an *interpretation*: scene operations it can preview, show, and apply
 * or discard, exactly like an edit made by hand.
 *
 *   text → IntentReader → validateIntent → SceneIntent
 *        → resolve (entities) → StructuredCommand → validateCommand
 *        → compile → ProposedChange[] (SceneOperation[])
 *        → preview → apply → history → Scene → renderer
 *
 * Everything downstream of the reader is the same machinery a drag goes
 * through, so whatever reads the words inherits undo, preview and the
 * renderer for free, and can never reach past them.
 *
 * An interpreter describes itself, and the interface makes it say *how* it
 * reads a command. A rule-based reader normalises wording and matches a
 * known set of intents; a model reads language. The workspace shows which
 * one is answering rather than letting a person assume.
 */

/**
 * Reads words into an intent, and nothing more. Its output is untrusted:
 * the interpreter validates it (`validateIntent`) before compiling it, so a
 * model and the rules are held to the same schema. It never sees operations,
 * the renderer or the history.
 */
export interface IntentReader {
  readonly kind: "rules" | "model";
  readonly name: string;
  /** An intent-shaped value, or null when the words are not an edit it knows. */
  read(text: string, signal: AbortSignal): Promise<unknown>;
}

/** What the person asked, with the context needed to resolve words like "this". */
export interface SceneCommand {
  text: string;
  /** The object in focus when the command was written, if any. */
  subjectId: Id | null;
  /** The scene the command is about. */
  scene: Scene;
}

/** One of the pieces a name could mean, with where it stands, so the person can say which. */
export interface ClarifyOption {
  id: Id;
  label: string;
  /** Where it is, from the scene's geometry: "front left, beside the sofa". Empty when nothing sets it apart. */
  description: string;
}

export type Clarification =
  | { reason: "no-selection" }
  | { reason: "ambiguous"; options: readonly ClarifyOption[] }
  | { reason: "no-target" }
  | { reason: "no-reference" }
  | { reason: "out-of-range" };

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
  /** The structured command in a few words, for the history: "Move sofa toward glazed door". */
  title: string;
  summary: string;
  changes: readonly ProposedChange[];
  intent: SceneIntent;
  /** What the intent resolved to in this scene, ids and all; the changes are compiled from it. */
  structured: StructuredCommand;
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
  | {
      outcome: "unavailable";
      message: string;
      command: string;
      intent: SceneIntent;
      request?: ReplacementRequest;
      /** Not a missing capability: what was asked is already true of the room, so nothing changes. */
      already?: true;
    }
  | { outcome: "clarify"; message: string; intent: SceneIntent; clarification: Clarification }
  | { outcome: "unsupported"; message: string; intent?: SceneIntent };

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
