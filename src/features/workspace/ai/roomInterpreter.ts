import type { ObjectCategory, Scene } from "@/scene/model/types";
import { validateIntent } from "./intent";
import type { CommandInterpreter, IntentReader, InterpretationResult, SceneCommand } from "./interpreter";
import { compileIntent, MESSAGES } from "./rules/compile";
import { ruleReader } from "./rules/read";

/**
 * The room's command interpreter.
 * ================================================================
 *
 *   text → reader → validateIntent → SceneIntent
 *        → resolveIntent → StructuredCommand → validateCommand → compileCommand → ProposedChange[]
 *
 * The reader is the only part that reads words, and its answer is checked
 * against the intent schema before anything is built from it: a model
 * plugged in here is held to exactly what the rules are. Resolving names
 * to the scene's ids, checking the resulting command and compiling it are
 * deterministic and never touch the renderer; what is proposed is applied,
 * if at all, through the workspace's history.
 *
 * `ruleReader` is the reader in this build. It is not a language model and
 * does not pretend to be one: it normalises wording into a known set of
 * intents, and anything outside them is answered as not understood.
 */

/** Every category the Scene has, for validating what a reader names. */
export const CATEGORIES: readonly ObjectCategory[] = [
  "sofa", "armchair", "lounge-chair", "coffee-table", "side-table", "sideboard", "media-console", "television", "bookshelf", "rug",
  "floor-lamp", "pendant-lamp", "plant", "artwork", "vase", "books", "cushion", "ottoman", "basket", "curtain", "bench", "chair",
  "dining-table", "desk", "cabinet", "bed",
];

export function createRoomInterpreter(original: Scene, reader: IntentReader = ruleReader): CommandInterpreter {
  return {
    name: reader.name,
    kind: reader.kind,
    note:
      reader.kind === "rules"
        ? "Reads a set of edit intents — move, turn, face, resize, remove, recolour, refinish, relight, replace, reset — however they are worded, and finds what they are about in this room. It is rule-based, not a language model."
        : "Reads your words with a language model into an edit intent, which is checked before anything in the room changes.",
    examples: [
      "Move the sofa closer to the window",
      "Rotate the sofa 20 degrees",
      "Make the sofa 15% bigger",
      "Move the floor lamp beside the sofa",
      "Move the coffee table left 30 cm",
      "Turn the chair to face the TV",
      "Make the sofa darker",
      "Change the curtains to white",
      "Make the room warmer",
      "Increase daylight",
      "Remove the ottoman",
      "Reset the room",
    ],
    available: true,

    async interpret(command: SceneCommand, signal: AbortSignal): Promise<InterpretationResult> {
      const read = await reader.read(command.text, signal);
      if (signal.aborted) throw new Error("Cancelled");
      if (read === null) return { outcome: "unsupported", message: MESSAGES.notUnderstood };
      const checked = validateIntent(read, CATEGORIES);
      if (!checked.ok) return { outcome: "unsupported", message: `That couldn’t be made into an edit: ${checked.reason}.` };
      return compileIntent(checked.intent, { scene: command.scene, original, selectionId: command.subjectId }, command.text);
    },
  };
}
