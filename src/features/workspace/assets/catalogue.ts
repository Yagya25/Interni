import type { SceneOperation } from "@/scene/model/operations";
import type { ObjectCategory, SceneObject } from "@/scene/model/types";
import type { ReplacementRequest } from "../ai/interpreter";

/**
 * What this build can actually put in a room.
 * ================================================================
 *
 * Replacing a piece needs a piece to replace it with. There is no asset
 * library yet; what exists is the set of forms the renderer has builders for
 * (`scene/render/objects`), each drawn to the piece's own measured size and
 * using the same material slots, so a sofa can become a curved sofa without
 * losing its upholstery.
 *
 * This is where asset retrieval will plug in. It receives the structured
 * request the interpreter produced and either returns a real operation or
 * nothing, in which case the request is shown as understood and not
 * available — never answered with invented geometry.
 */

interface FormEntry {
  form: string;
  /** How the form is named back to the person. */
  label: string;
  /** Words that ask for it. */
  words: readonly string[];
}

/** Every entry has a builder that draws it; keep the two in step. */
const FORMS: Partial<Record<ObjectCategory, readonly FormEntry[]>> = {
  sofa: [
    { form: "track-arm", label: "track-arm sofa", words: ["track arm", "straight", "classic", "standard", "boxy"] },
    { form: "curved", label: "curved sofa", words: ["curved", "curvy", "round", "rounded", "crescent"] },
  ],
  "coffee-table": [
    { form: "slab", label: "rectangular coffee table", words: ["rectangular", "rectangle", "slab"] },
    { form: "drum", label: "round drum coffee table", words: ["round", "circular", "drum"] },
  ],
  "side-table": [
    { form: "round", label: "round side table", words: ["round", "circular"] },
    { form: "block", label: "block side table", words: ["block", "cube", "boxy"] },
  ],
  rug: [
    { form: "rect", label: "rectangular rug", words: ["rectangular", "rectangle"] },
    { form: "round", label: "round rug", words: ["round", "circular"] },
  ],
  plant: [
    { form: "fiddle-leaf", label: "fiddle-leaf fig", words: ["fiddle leaf", "fig"] },
    { form: "olive", label: "olive tree", words: ["olive tree", "olive"] },
  ],
  "floor-lamp": [
    { form: "tripod", label: "tripod floor lamp", words: ["tripod"] },
    { form: "globe", label: "globe floor lamp", words: ["globe", "sphere", "ball"] },
  ],
  "pendant-lamp": [
    { form: "dome", label: "dome pendant", words: ["dome"] },
    { form: "lantern", label: "paper lantern pendant", words: ["lantern", "paper"] },
  ],
};

/** Every word any buildable form answers to, for the reader to recognise. */
export const BUILDABLE_FORM_WORDS: readonly string[] = [
  ...new Set(Object.values(FORMS).flatMap((entries) => entries?.flatMap((e) => e.words) ?? [])),
];

/** The buildable form a request asks for, for this kind of piece. */
function formFor(object: SceneObject, request: ReplacementRequest) {
  const wanted = request.requestedForm.toLowerCase();
  return FORMS[object.category]?.find((entry) =>
    entry.words.some((word) => new RegExp(`\\b${word}\\b`).test(wanted)),
  );
}

/**
 * Turn a replacement request into an operation, if this build can draw what
 * was asked for. The piece keeps its identity, place, size and materials;
 * only its form changes.
 */
export function fulfil(
  object: SceneObject,
  request: ReplacementRequest,
): { operation: SceneOperation; label: string } | null {
  const entry = formFor(object, request);
  if (!entry || entry.form === object.form) return null;
  return {
    operation: { kind: "replace", objectId: object.id, replacement: { ...object, form: entry.form } },
    label: entry.label,
  };
}

/**
 * Whether the piece already has the form a request names. A request that
 * names no form this kind of piece has is never already true of it, even
 * when the piece has no form of its own.
 */
export function alreadyIs(object: SceneObject, request: ReplacementRequest) {
  const entry = formFor(object, request);
  return entry !== undefined && entry.form === object.form;
}
