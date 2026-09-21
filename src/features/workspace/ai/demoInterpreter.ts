import type { Scene } from "@/scene/model/types";
import { MESSAGES, plan } from "./demo/plan";
import { parse } from "./demo/language";
import type { CommandInterpreter, InterpretationResult, SceneCommand } from "./interpreter";

/**
 * A rule-based interpreter for the demonstration room.
 *
 * It is not a language model and does not pretend to be one. It normalises
 * wording — synonyms, spelling, phrasings — into a known set of intents,
 * resolves what they are about against the scene, and turns them into real
 * scene operations. A request it cannot map to an edit is answered as such,
 * which is a far better answer than a guess.
 *
 * Its purpose is to make the whole path real — command, intent, operations,
 * preview, apply, undo — so that connecting a model later is a matter of
 * implementing this one interface, with everything downstream proven.
 */
export function createDemoInterpreter(original: Scene): CommandInterpreter {
  return {
    name: "Room rules",
    kind: "rules",
    note: "Reads a set of edit intents — move, turn, resize, recolour, relight, replace, reset — however they are worded. It is rule-based, not a language model.",
    examples: [
      "Make this darker",
      "Rotate this 30 degrees",
      "Warm up the room",
      "Move the couch nearer the window",
      "Paint the walls sage",
      "Make the coffee table round",
      "Turn on the floor lamp",
      "Reset the room",
    ],
    available: true,

    async interpret(command: SceneCommand, signal: AbortSignal): Promise<InterpretationResult> {
      if (signal.aborted) throw new Error("Cancelled");
      const intent = parse(command.text);
      if (!intent) return { outcome: "unsupported", message: MESSAGES.notUnderstood };
      return plan(intent, { scene: command.scene, original, selectionId: command.subjectId }, command.text);
    },
  };
}
