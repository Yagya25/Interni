import { BUILDABLE_FORM_WORDS } from "../../assets/catalogue";
import type { CommandIntent, IntentKind, IntentTarget } from "../interpreter";
import {
  ALL_LAMPS,
  ANGLE_WORDS,
  CANONICAL,
  COLOURS,
  MATERIAL_WORDS,
  OBJECT_NAMES,
  OPENING_NAMES,
  ROOM_WORDS,
  SELECTION_WORDS,
  SURFACE_NAMES,
  UNAVAILABLE_EDITS,
  UNBUILT_FORMS,
} from "./vocabulary";

/**
 * Reading a command.
 * ================================================================
 *
 * A rule-based reader, not a language model. It works in two steps:
 *
 *   1. normalise — case, punctuation, spelling variants and synonyms are
 *      folded into one canonical vocabulary, so "darken this", "make this
 *      more dark" and "give this a darker colour" all read "… darker …";
 *   2. interpret — a short, ordered list of intent rules each looks for its
 *      own canonical words and produces one structured `CommandIntent`.
 *
 * Names are not resolved here. The reader only records the words that name
 * the target; `plan.ts` looks them up in the scene, where it can tell a
 * sofa from a couch that isn't there, or two tables apart.
 *
 * Anything outside these rules returns null, and the workspace says so.
 */

/** Fold wording into the canonical vocabulary. */
export function normalise(input: string): string {
  let text = input
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s°%-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [pattern, word] of CANONICAL) text = text.replace(pattern, word);
  return text.replace(/\s+/g, " ").trim();
}

const colourNames = Object.keys(COLOURS);
/** Form words, less those that are also colours ("olive" is a colour; "olive tree" a form). */
const FORM_WORDS = [...new Set([...BUILDABLE_FORM_WORDS, ...UNBUILT_FORMS])].filter((w) => !colourNames.includes(w));
const NAME_WORDS = [...new Set(Object.values(OBJECT_NAMES).flat())];
const has = (text: string, word: string) => new RegExp(`\\b${escape(word)}\\b`).test(text);

/** Verbs a piece-related command starts with, to find an unknown name after them. */
const LEADING = /^(?:please |can you |could you |i want to |id like to |lets )?(?:make|move|rotate|turn|resize|replace|change|set|give|switch|paint)?\s*(?:the|a|an|my|this|that)?\s*/;

export function parse(input: string): CommandIntent | null {
  const raw = input.toLowerCase();
  const text = normalise(input);
  if (!text) return null;

  const intent = (
    kind: IntentKind,
    action: string,
    target: IntentTarget,
    parameters: CommandIntent["parameters"] = {},
    confidence = 0.9,
  ): CommandIntent => ({ intent: kind, target, action, parameters, confidence, clarificationRequired: null });

  // Reset --------------------------------------------------------------------
  if (/\b(reset|start over|start again)\b|\bundo everything\b|\b(put|move) everything back\b|\bback to (?:the )?original\b|\brestore the room\b/.test(raw)) {
    return intent("reset", "reset", { kind: "room" }, {}, 0.95);
  }

  // Switching a light ------------------------------------------------------
  if ((/\b(turn|switch)\b/.test(text) && /\b(on|off)\b/.test(text) && !/\binto\b/.test(text)) || /\blight up\b/.test(text)) {
    const on = /\bon\b|\blight up\b/.test(text);
    return intent("switch", on ? "switch-on" : "switch-off", targetOf(text), {
      on,
      every: ALL_LAMPS.test(text),
    });
  }

  // Replacing a piece with another form ------------------------------------
  const forms = FORM_WORDS.filter((word) => has(text, word));
  const connector = text.match(/\b(?:with|for|to|into)\b\s+(.+)$/);
  const replaceVerb = /\breplace\b/.test(text);
  const changeVerb = /\b(change|convert|transform|turn|make|want|swap|upgrade)\b/.test(text);
  if ((replaceVerb && connector) || (forms.length > 0 && (replaceVerb || changeVerb))) {
    const subject = connector ? text.slice(0, connector.index) : text;
    const wanted = connector ? connector[1] : text;
    const attributes = [
      ...colourNames.filter((c) => has(wanted, c)),
      ...MATERIAL_WORDS.filter((m) => has(wanted, m)),
    ];
    return intent(
      "replace",
      "replace",
      targetOf(subject),
      {
        requestedForm: asWritten(forms.length > 0 ? forms.join(" ") : describeRequest(wanted, attributes)),
        requestedAttributes: attributes,
      },
      forms.length > 0 ? 0.9 : 0.7,
    );
  }

  // Turning ------------------------------------------------------------------
  if (/\brotate\b/.test(text) || (/\bturn\b/.test(text) && !/\binto\b/.test(text))) {
    if (/\bface\b/.test(text)) return intent("unavailable", "face", targetOf(text), {}, 0.8);
    const anticlockwise = /\b(anticlockwise|left)\b/.test(text);
    const degrees = angleIn(text) ?? 45;
    return intent("rotate", "rotate", targetOf(text), { degrees: anticlockwise ? -degrees : degrees });
  }

  // Moving relative to something ------------------------------------------------
  const relation = text.match(/\b(toward|awayfrom)\b\s*(?:the\s+)?(.*)$/);
  if (relation || /\bmove\b/.test(text)) {
    if (!relation) return intent("move", "move", targetOf(text), { relation: "none", reference: "" }, 0.6);
    return intent("move", relation[1] === "toward" ? "move-closer" : "move-away", targetOf(text.slice(0, relation.index)), {
      relation: relation[1] === "toward" ? "closer" : "away",
      reference: relation[2].trim(),
    });
  }

  // A named colour --------------------------------------------------------------
  const colour = colourNames.find((c) => has(text, c));
  if (colour && /\b(make|paint|colour|recolour|change|turn|dye|in)\b/.test(text)) {
    return intent("recolour", "recolour", targetOf(text), { colour });
  }

  // Warmth, tone, light and size ----------------------------------------------------
  const lighting = /\b(lighting|lights|bulbs|lamps)\b/.test(text);
  if (/\bwarmer\b/.test(text) || /\bcooler\b/.test(text)) {
    const warmer = /\bwarmer\b/.test(text);
    return intent("warmth", warmer ? "warm" : "cool", targetOf(text), { direction: warmer ? 1 : -1, lighting });
  }
  if (/\b(brighter|dimmer)\b/.test(text)) {
    const brighter = /\bbrighter\b/.test(text);
    return intent("brightness", brighter ? "brighten" : "dim", targetOf(text), { direction: brighter ? 1 : -1, lighting });
  }
  if (/\b(darker|lighter)\b/.test(text)) {
    const darker = /\bdarker\b/.test(text);
    return intent("tone", darker ? "darken" : "lighten", targetOf(text), { tone: darker ? "darker" : "lighter" });
  }
  if (/\b(bigger|smaller)\b/.test(text)) {
    const bigger = /\bbigger\b/.test(text);
    const percent = text.match(/\b(\d+(?:\.\d+)?)\s*(?:%|percent)/);
    const step = percent ? Number(percent[1]) / 100 : bigger ? 0.15 : 0.13;
    return intent("size", bigger ? "enlarge" : "shrink", targetOf(text), { factor: bigger ? 1 + step : 1 - step });
  }

  // Recognised as an edit, but not one this build can make ----------------------
  const verb = text.match(UNAVAILABLE_EDITS);
  if (verb) return intent("unavailable", verb[1], targetOf(text), {}, 0.7);

  return null;
}

/**
 * What a clause names. Known names (from the vocabulary) are left for the
 * planner to resolve; the room and "this" are recognised here; and a word
 * that names nothing known is kept, so the answer can say it isn't here.
 */
function targetOf(clause: string): IntentTarget {
  const namesSomething =
    NAME_WORDS.some((name) => has(clause, name)) ||
    Object.values(SURFACE_NAMES).some((pattern) => pattern.test(clause)) ||
    Object.values(OPENING_NAMES).some((pattern) => pattern.test(clause)) ||
    ALL_LAMPS.test(clause);
  if (namesSomething) return { kind: "named", phrase: clause };
  if (ROOM_WORDS.test(clause)) return { kind: "room" };
  const pointer = clause.match(SELECTION_WORDS);
  if (pointer) return { kind: "selection", word: pointer[1] };
  const remainder = clause
    .replace(LEADING, "")
    .replace(/\b(toward|awayfrom|darker|lighter|brighter|dimmer|warmer|cooler|bigger|smaller|rotate|degrees|clockwise|anticlockwise|left|right|by|a bit|slightly|more|less|much|please)\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return remainder.length > 1 ? { kind: "named", phrase: remainder } : { kind: "unspecified" };
}

/** An angle in the text: a number, or one written out. */
function angleIn(text: string): number | null {
  const number = text.match(/\b(\d+(?:\.\d+)?)\s*(?:degrees)?\b/);
  if (number) return Number(number[1]);
  const written = Object.keys(ANGLE_WORDS)
    .sort((a, b) => b.length - a.length)
    .find((word) => has(text, word));
  return written ? ANGLE_WORDS[written] : null;
}

/** "a green velvet one" → "green velvet". Used when no known form was named. */
function describeRequest(wanted: string, attributes: readonly string[]) {
  const words = wanted
    .replace(/\b(a|an|the|one|new|different|with|some)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words || attributes.join(" ") || "different";
}

/** Letter-shaped forms are written with a capital: "l-shaped" → "L-shaped". */
const asWritten = (form: string) =>
  form.replace(/\b([lu])-shaped\b/g, (_, letter: string) => `${letter.toUpperCase()}-shaped`);

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
