import { ALLOWED_CLASSES } from "@/scene/compile/materials";
import { findById, walls } from "@/scene/model/queries";
import type { ArtificialLight, Id, Opening, Scene, SceneObject, Surface, WallSurface } from "@/scene/model/types";
import { alreadyIs, fulfil } from "../../assets/catalogue";
import { primarySlot, type MoveWay, type PlaceRef, type StructuredCommand } from "../command";
import type { EntityRef, MoveRelation, NearPredicate, ObjectRef, SceneIntent, Side } from "../intent";
import type { Clarification, ClarifyOption, ReplacementRequest } from "../interpreter";
import { MESSAGES } from "./messages";
import { cameraFrame, gapTo, holds, nearestWall } from "./spatial";

/**
 * Which things in the scene a command means.
 * ================================================================
 *
 * Resolution order, strongest first:
 *
 *   1. the selected piece, for "this", "it", "that chair" (when it is a chair),
 *      and when a name fits several pieces and one of them is selected;
 *   2. pieces of the category the words name, and pieces the words are
 *      an alias of ("chair" is a chair, and an armchair is a chair too) —
 *      the category's own first;
 *   3. qualifiers: a relationship the scene holds and that still holds
 *      ("the lamp beside the sofa"), failing that the plainly nearest
 *      ("the chair near the window"); a side as the photograph's camera saw
 *      it ("the left curtain", "the front-right chair"); a number
 *      ("armchair 2", "the second armchair");
 *   4. otherwise, if two pieces still fit, a question back, each piece
 *      described by where it stands — never a guess.
 *
 * Plurals ("the curtains") mean every piece that answers. A name nothing in
 * the room answers to is said to be missing, in the person's own words.
 *
 * `resolveIntent` then turns a whole intent into a `StructuredCommand`:
 * every reference replaced by the id it resolved to.
 */

export type Resolved =
  | { kind: "objects"; objects: SceneObject[] }
  | { kind: "surfaces"; label: string; surface: "walls" | "floor" | "ceiling"; surfaces: Surface[] }
  | { kind: "openings"; label: string; openings: Opening[] }
  | { kind: "lamps"; lamps: ArtificialLight[] }
  | { kind: "room" }
  | { kind: "clarify"; clarification: Clarification; message: string }
  | { kind: "missing"; message: string };

export const WHICH_OBJECT = MESSAGES.whichObject;

export interface ResolveOptions {
  /** With nothing named or selected, whether the room itself is a sensible subject. */
  roomFallback: boolean;
}

export function resolveEntity(scene: Scene, ref: EntityRef, selectionId: Id | null, options: ResolveOptions): Resolved {
  const selected = selectionId ? findById(scene.objects, selectionId) : undefined;
  switch (ref.kind) {
    case "room":
      return { kind: "room" };
    case "selection":
      return selected ? { kind: "objects", objects: [selected] } : { kind: "clarify", clarification: { reason: "no-selection" }, message: WHICH_OBJECT };
    case "unspecified":
      if (selected) return { kind: "objects", objects: [selected] };
      if (options.roomFallback) return { kind: "room" };
      return { kind: "clarify", clarification: { reason: "no-target" }, message: WHICH_OBJECT };
    case "lamps": {
      const lamps = lampsIn(scene);
      return lamps.length ? { kind: "lamps", lamps } : { kind: "missing", message: "There are no lamps in this room." };
    }
    case "surface": {
      const surfaces = ref.surface === "walls" ? walls(scene) : scene.surfaces.filter((s) => s.kind === ref.surface);
      const label = ref.surface === "walls" ? "Walls" : ref.surface === "floor" ? "Floor" : "Ceiling";
      return surfaces.length ? { kind: "surfaces", label, surface: ref.surface, surfaces } : { kind: "missing", message: `There’s no ${label.toLowerCase()} in this room’s model.` };
    }
    case "opening": {
      // "The door" is also a glazed door the reconstruction counts as a window.
      const ofKind = scene.openings.filter((o) => o.kind === ref.opening);
      const openings = ofKind.length > 0 ? ofKind : scene.openings.filter((o) => new RegExp(`\\b${ref.opening}\\b`, "i").test(o.label));
      return openings.length
        ? { kind: "openings", label: openings.length > 1 ? `${ref.opening}s` : openings[0].label, openings }
        : { kind: "missing", message: `There’s no ${ref.opening} in this room.` };
    }
    case "object":
      return resolveObject(scene, ref, selected);
  }
}

function resolveObject(scene: Scene, ref: ObjectRef, selected: SceneObject | undefined): Resolved {
  if (ref.pointed && selected && [...ref.categories, ...ref.aliasOf].includes(selected.category)) {
    return { kind: "objects", objects: [selected] };
  }
  // The category's own pieces first, then what the word is also a name for.
  let found = [...scene.objects.filter((o) => ref.categories.includes(o.category)), ...scene.objects.filter((o) => ref.aliasOf.includes(o.category))];
  if (found.length === 0) {
    return { kind: "missing", message: `There’s no ${singular(ref)} in this room.` };
  }

  if (ref.near) {
    const anchor = resolveEntity(scene, ref.near.of, selected?.id ?? null, { roomFallback: false });
    const things = anchorThings(scene, anchor);
    if (!things) return anchor.kind === "clarify" || anchor.kind === "missing" ? anchor : { kind: "missing", message: `I couldn’t find what the ${singular(ref)} is ${phrase(ref.near.predicate)}.` };
    let related = found.filter((o) => relatesTo(scene, o.id, ref.near!.predicate, new Set(things.map((t) => t.id))));
    if (related.length === 0 && (ref.near.predicate === "near" || ref.near.predicate === "beside")) {
      related = nearestOf(scene, found, things, ref.near.predicate === "beside" ? 0.6 : 1.5);
    }
    if (related.length === 0) {
      return { kind: "missing", message: `There’s no ${singular(ref)} ${phrase(ref.near.predicate)} ${anchorLabel(anchor)} in this room.` };
    }
    found = related;
  }

  if (ref.ordinal !== null) {
    const numbered = found.filter((o) => new RegExp(`\\s${ref.ordinal}$`).test(o.label));
    const byOrder = [...found].sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
    const pick = numbered.length === 1 ? numbered[0] : numbered.length > 1 ? undefined : byOrder[ref.ordinal - 1];
    if (numbered.length > 1) {
      found = numbered;
    } else if (!pick) {
      const count = found.length === 1 ? `There’s only one ${singular(ref)}` : `There are only ${found.length} ${pluralWord(ref)}`;
      return { kind: "missing", message: `${count} here, so there is no number ${ref.ordinal}.` };
    } else {
      found = [pick];
    }
  }

  if (ref.sides.length > 0 && found.length > 1) {
    const pick = bySides(scene, found, ref.sides);
    if (pick) found = [pick];
  }

  if (ref.plural || found.length === 1) return { kind: "objects", objects: found };
  if (selected && found.includes(selected)) return { kind: "objects", objects: [selected] };
  return {
    kind: "clarify",
    clarification: { reason: "ambiguous", options: describeAmong(scene, found) },
    message: `I found ${found.length} ${pluralWord(ref)}. Which one do you mean?`,
  };
}

// ---------------------------------------------------------------------------
// Relationships and nearness

type Thing = SceneObject | Opening | WallSurface;

/** What an anchor resolved to, as things a piece can be near. */
function anchorThings(scene: Scene, anchor: Resolved): Thing[] | null {
  if (anchor.kind === "objects") return anchor.objects;
  if (anchor.kind === "surfaces") return anchor.surfaces.filter((s): s is WallSurface => s.kind === "wall");
  if (anchor.kind === "openings") return anchor.openings;
  return null;
}

function anchorLabel(anchor: Resolved) {
  if (anchor.kind === "objects") return `the ${anchor.objects[0].label.toLowerCase()}`;
  if (anchor.kind === "surfaces") return `the ${anchor.label.toLowerCase()}`;
  if (anchor.kind === "openings") return `the ${anchor.label.toLowerCase()}`;
  return "it";
}

/** Symmetric predicates hold either way round: a lamp beside a sofa is a sofa beside a lamp. */
const SYMMETRIC: readonly NearPredicate[] = ["beside", "opposite", "faces", "near"];

/** Whether the scene records this relationship between a piece and any of the anchors, and it still holds. */
function relatesTo(scene: Scene, id: Id, predicate: NearPredicate, anchors: Set<Id>) {
  return scene.relationships.some(
    (r) =>
      (predicate === "near" ? r.predicate !== "lit-by" : r.predicate === predicate) &&
      ((r.subjectId === id && anchors.has(r.objectId)) || (SYMMETRIC.includes(predicate) && r.objectId === id && anchors.has(r.subjectId))) &&
      holds(scene, r),
  );
}

/**
 * With no relationship recorded, the piece plainly nearest the anchor: one
 * within `reach` and clearly nearer (by 30 cm) than the next, or every piece
 * within reach when none is clearly nearest, to be asked about.
 */
function nearestOf(scene: Scene, candidates: readonly SceneObject[], things: readonly Thing[], reach: number): SceneObject[] {
  const ranked = candidates
    .map((o) => ({ o, gap: Math.min(...things.filter((t) => t.id !== o.id).map((t) => gapTo(scene, o, t))) }))
    .filter((x) => x.gap <= reach)
    .sort((a, b) => a.gap - b.gap);
  if (ranked.length <= 1) return ranked.map((x) => x.o);
  return ranked[1].gap - ranked[0].gap >= 0.3 ? [ranked[0].o] : ranked.map((x) => x.o);
}

// ---------------------------------------------------------------------------
// Sides, as the photograph's camera saw the room

/** Where a piece stands in the photograph: across (left −, right +) and in depth (front −, back +). */
function inPhoto(scene: Scene, o: SceneObject) {
  const { forward, right } = cameraFrame(scene);
  const [px, , pz] = scene.camera.position;
  const d = [o.transform.position[0] - px, o.transform.position[2] - pz];
  return { across: d[0] * right[0] + d[1] * right[1], depth: d[0] * forward[0] + d[1] * forward[1] };
}

/**
 * The piece furthest towards the named sides — "left", or "front" and
 * "right" together, which is the diagonal between them. A side is only an
 * answer when it separates the pieces clearly (15 cm).
 */
function bySides(scene: Scene, objects: readonly SceneObject[], sides: readonly Side[]) {
  const along = (o: SceneObject) => {
    const p = inPhoto(scene, o);
    return sides.reduce((sum, s) => sum + (s === "right" ? p.across : s === "left" ? -p.across : s === "back" ? p.depth : -p.depth), 0) / Math.sqrt(sides.length);
  };
  const sorted = [...objects].sort((a, b) => along(b) - along(a));
  return along(sorted[0]) - along(sorted[1]) >= 0.15 ? sorted[0] : null;
}

/**
 * Each of several pieces, described by where it stands among the others —
 * front or back, left or right, as the photograph shows them (only where it
 * clearly stands apart, by 30 cm) — and by what it is near. The words are
 * ones the resolver reads back: "the front-left armchair", "the armchair
 * near the sofa".
 */
export function describeAmong(scene: Scene, objects: readonly SceneObject[]): ClarifyOption[] {
  const at = objects.map((o) => inPhoto(scene, o));
  // The margin a side needs to be an answer, as `bySides` reads it back.
  const MARGIN = 0.15;
  const place = (i: number, axis: "across" | "depth", low: string, high: string) => {
    const mine = at[i][axis];
    const others = at.filter((_, j) => j !== i).map((p) => p[axis]);
    if (mine < Math.min(...others) - MARGIN) return low;
    if (mine > Math.max(...others) + MARGIN) return high;
    return null;
  };
  // Between others on both sides, in depth or across.
  const middle = (i: number) => {
    if (objects.length < 3) return null;
    const between = (axis: "across" | "depth") => {
      const others = at.filter((_, j) => j !== i).map((p) => p[axis]);
      return others.some((v) => v < at[i][axis] - MARGIN) && others.some((v) => v > at[i][axis] + MARGIN);
    };
    return between("depth") || between("across") ? "middle" : null;
  };
  return objects.map((o, i) => {
    const sides = [place(i, "depth", "front", "back"), place(i, "across", "left", "right")].filter(Boolean).join(" ") || middle(i);
    const near = neighbourOf(scene, o, objects);
    return { id: o.id, label: o.label, description: [sides, near].filter(Boolean).join(", ") };
  });
}

/** What a piece is beside, above or near, among the pieces it isn't being told apart from. */
function neighbourOf(scene: Scene, o: SceneObject, among: readonly SceneObject[]): string | null {
  const skip = new Set(among.map((x) => x.id));
  const recorded = scene.relationships.find(
    (r) => (r.subjectId === o.id || r.objectId === o.id) && ["beside", "above", "in-front-of", "on"].includes(r.predicate) && holds(scene, r) && !skip.has(r.subjectId === o.id ? r.objectId : r.subjectId) && findById(scene.objects, r.subjectId === o.id ? r.objectId : r.subjectId),
  );
  if (recorded) {
    const other = findById(scene.objects, recorded.subjectId === o.id ? recorded.objectId : recorded.subjectId)!;
    const word = recorded.subjectId === o.id ? phrase(recorded.predicate) : recorded.predicate === "beside" ? "beside" : "near";
    return `${word} the ${other.label.toLowerCase()}`;
  }
  const pieces = scene.objects.filter((x) => !skip.has(x.id) && x.category !== o.category && x.dimensions[1] * x.transform.scale[1] > 0.05);
  const nearest = pieces.map((x) => ({ x, gap: gapTo(scene, o, x) })).sort((a, b) => a.gap - b.gap)[0];
  if (nearest && nearest.gap <= 1) return `near the ${nearest.x.label.toLowerCase()}`;
  const opening = scene.openings.map((x) => ({ x, gap: gapTo(scene, o, x) })).sort((a, b) => a.gap - b.gap)[0];
  if (opening && opening.gap <= 1) return `near the ${opening.x.label.toLowerCase()}`;
  return null;
}

// ---------------------------------------------------------------------------
// From an intent to a command

export type Resolution =
  | { ok: true; command: StructuredCommand }
  | { ok: false; outcome: "clarify"; clarification: Clarification; message: string }
  | { ok: false; outcome: "unsupported"; message: string }
  | { ok: false; outcome: "unavailable"; message: string; request?: ReplacementRequest; already?: true };

const refuse = (message: string): Resolution => ({ ok: false, outcome: "unsupported", message });
const unavailable = (message: string = MESSAGES.unavailable, request?: ReplacementRequest): Resolution => ({ ok: false, outcome: "unavailable", message, ...(request && { request }) });
const clarify = (clarification: Clarification, message: string): Resolution => ({ ok: false, outcome: "clarify", clarification, message });
const failed = (r: Resolved): Resolution => (r.kind === "clarify" ? clarify(r.clarification, r.message) : refuse(r.kind === "missing" ? r.message : WHICH_OBJECT));
const done = (command: StructuredCommand): Resolution => ({ ok: true, command });

/**
 * Find everything an intent names, and say it as a command in the scene's
 * own ids — or say why it can't be: a question when the words fit more
 * than one thing, a refusal when they fit nothing or ask for something no
 * room can do, "not yet" when this build can't.
 */
export function resolveIntent(intent: SceneIntent, scene: Scene, selectionId: Id | null, text: string): Resolution {
  const resolve = (ref: EntityRef, roomFallback = false) => resolveEntity(scene, ref, selectionId, { roomFallback });
  const pieces = (r: Resolved): { objects: SceneObject[] } | Resolution => {
    if (r.kind === "objects") return { objects: r.objects };
    if (r.kind === "room") return clarify({ reason: "no-target" }, WHICH_OBJECT);
    // Openings and surfaces are the room's shell: they are named, found, and said to be fixed.
    if (r.kind === "openings") return unavailable(`The ${r.label.toLowerCase()} is part of the wall. Moving, turning, resizing or removing a window or a door isn’t available yet.`);
    if (r.kind === "surfaces") return refuse(`The ${r.label.toLowerCase()} ${r.label === "Walls" ? "are" : "is"} the room itself, not a piece in it. I can change ${r.label === "Walls" ? "their" : "its"} colour or finish.`);
    if (r.kind === "lamps") return { objects: r.lamps.map((l) => findById(scene.objects, l.fixtureId)!).filter(Boolean) };
    return failed(r);
  };
  const targetOf = (objects: readonly SceneObject[]) => (objects.length === 1 ? { kind: "object" as const, id: objects[0].id } : { kind: "objects" as const, ids: objects.map((o) => o.id) });

  switch (intent.type) {
    case "reset_room":
      return done({ type: "RESET_ROOM" });

    case "unavailable_edit":
      return unavailable(
        intent.verb === "add"
          ? "Adding a piece that isn’t in the room needs furniture assets, which aren’t available yet."
          : intent.verb === "corner" || intent.verb === "middle"
            ? `Moving a piece into the ${intent.verb === "corner" ? "corner" : "middle of the room"} isn’t available yet. Try “closer to the window”, “left 50 cm” or “against the wall”.`
            : MESSAGES.unavailable,
      );

    case "rotate_object": {
      const found = pieces(resolve(intent.target));
      if (!("objects" in found)) return found;
      if (intent.degrees !== null) return done({ type: "ROTATE_OBJECT", target: targetOf(found.objects), parameters: { degrees: intent.degrees, face: null } });
      const face = placeRef(scene, resolve(intent.face!), found.objects[0], "to face");
      return "ok" in face ? face : done({ type: "ROTATE_OBJECT", target: targetOf(found.objects), parameters: { degrees: null, face } });
    }

    case "scale_object": {
      const found = pieces(resolve(intent.target));
      if (!("objects" in found)) return found;
      return done({ type: "SCALE_OBJECT", target: targetOf(found.objects), parameters: { factor: intent.factor } });
    }

    case "remove_object": {
      const r = resolve(intent.target);
      if (r.kind === "room") return unavailable("Emptying the whole room isn’t something one command does. Name the piece to take away.");
      const found = pieces(r);
      if (!("objects" in found)) return found;
      return done({ type: "REMOVE_OBJECT", target: targetOf(found.objects) });
    }

    case "move_object": {
      const found = pieces(resolve(intent.target));
      if (!("objects" in found)) return found;
      if (found.objects.length > 1) return refuse(`Move one piece at a time — say which ${intent.target.kind === "object" ? singular(intent.target) : "one"}.`);
      const object = found.objects[0];
      const { destination, distance, degree: amount } = intent;
      if (!destination) return clarify({ reason: "no-reference" }, MESSAGES.whereTo);
      if (destination.kind === "direction") {
        return done({ type: "MOVE_OBJECT", target: { kind: "object", id: object.id }, parameters: { direction: destination.direction, reference: null, distance, amount } });
      }
      const r = resolve(destination.reference);
      const impossible = impossiblePlace(object, destination.relation, r);
      if (impossible) return impossible;
      if (r.kind === "missing" && destination.reference.kind === "object" && destination.reference.categories.length === 0 && destination.reference.aliasOf.length === 0) {
        const words = asTyped(text, destination.reference.words);
        return refuse(`“${words}” isn’t anything in this room, so there’s nowhere there to move the ${object.label.toLowerCase()} to. I can move it closer to or away from something here, beside, in front of or behind another piece, against the wall, or left, right, forward or back.`);
      }
      if (r.kind === "missing") return refuse(r.message.replace(" in this room.", " in this room to move it to."));
      if (r.kind === "clarify") return clarify(r.clarification, r.message);
      if (r.kind === "objects" && r.objects.some((o) => o.id === object.id)) return refuse(`The ${object.label.toLowerCase()} can’t be moved relative to itself.`);
      if (r.kind === "objects" && r.objects.length > 1) {
        return clarify({ reason: "ambiguous", options: describeAmong(scene, r.objects) }, `Which one — ${listOf(r.objects.map((o) => o.label.toLowerCase()))}?`);
      }

      const direction = WAYS[destination.relation];
      if (!direction) return refuse(`A piece can’t go ${destination.relation} that.`);
      const command = (reference: PlaceRef | null): Resolution =>
        done({ type: "MOVE_OBJECT", target: { kind: "object", id: object.id }, parameters: { direction, reference, distance, amount } });
      if (direction === "against") {
        if (r.kind === "surfaces" && r.surface === "walls") return command(null);
        return refuse("A piece can go against a wall. Try “move the sofa against the wall”.");
      }
      if (direction === "toward" || direction === "away") {
        const ref = placeRef(scene, r, object, direction === "toward" ? "closer to" : "away from");
        return "ok" in ref ? ref : command(ref);
      }
      if (r.kind !== "objects") return refuse(`A piece can go ${direction.replace(/_/g, " ")} another piece. Name the piece, e.g. “beside the sofa”.`);
      return command({ kind: "object", id: r.objects[0].id });
    }

    case "change_material": {
      const r = resolve(intent.target);
      const change = intent.change;
      if (r.kind === "room") {
        if (change.kind === "colour") {
          return refuse(`I can’t tint the whole room ${change.name}${/%/.test(text) ? " by a percentage" : ""}. I can make the room warmer or cooler (its light and walls), or paint the walls ${change.name} — try “paint the walls ${change.name}”.`);
        }
        return clarify({ reason: "no-target" }, WHICH_OBJECT);
      }
      if (r.kind === "openings") return unavailable("Changing the finish of a window or a door isn’t available yet.");
      if (change.kind === "not_a_finish") return refuse(notAFinish(scene, r, change.word));
      if (r.kind === "surfaces") return done({ type: "CHANGE_MATERIAL", target: { kind: "surfaces", surface: r.surface, ids: r.surfaces.map((s) => s.id) }, parameters: { change } });
      const found = pieces(r);
      if (!("objects" in found)) return found;
      const slots: { objectId: Id; slot: string }[] = [];
      for (const object of found.objects) {
        const slot = primarySlot(object);
        if (!slot || !findById(scene.materials, object.materials[slot])) return refuse(`The ${object.label.toLowerCase()} has no finish in the model to change.`);
        slots.push({ objectId: object.id, slot });
      }
      return done({ type: "CHANGE_MATERIAL", target: { kind: "slots", slots }, parameters: { change } });
    }

    case "change_lighting": {
      const r = resolve(intent.scope, true);
      if (intent.change === "more_daylight" || intent.change === "less_daylight" || r.kind === "room") {
        return done({ type: "CHANGE_LIGHTING", target: { kind: "room" }, parameters: { change: intent.change, includeSurfaces: intent.includeSurfaces } });
      }
      if (r.kind === "lamps") return done({ type: "CHANGE_LIGHTING", target: { kind: "lights", ids: r.lamps.map((l) => l.id) }, parameters: { change: intent.change, includeSurfaces: false } });
      if (r.kind !== "objects") return failed(r);
      const lamps = r.objects.map((o) => fixtureOf(scene, o)).filter((l): l is ArtificialLight => l !== undefined);
      if (lamps.length === r.objects.length) return done({ type: "CHANGE_LIGHTING", target: { kind: "lights", ids: lamps.map((l) => l.id) }, parameters: { change: intent.change, includeSurfaces: false } });
      // A piece that gives no light takes the change as a colour: "make it warmer" with the sofa selected.
      const tone = intent.change === "warmer" ? "warmer" : intent.change === "cooler" ? "cooler" : intent.change === "brighter" ? "lighter" : "darker";
      return resolveIntent({ type: "change_material", target: intent.scope, change: { kind: "tone", tone, degree: "normal" } }, scene, selectionId, text);
    }

    case "switch_light": {
      const r = resolve(intent.target);
      const fixtures = r.kind === "lamps" ? r.lamps : r.kind === "objects" ? r.objects.map((o) => fixtureOf(scene, o)).filter((l): l is ArtificialLight => l !== undefined) : [];
      if (fixtures.length === 0) {
        if (r.kind === "clarify" || r.kind === "missing") return failed(r);
        return r.kind === "room" ? clarify({ reason: "no-target" }, "Which light should I switch?") : unavailable("That isn’t a light this room can switch.");
      }
      return done({ type: "SWITCH_LIGHT", target: { kind: "lights", ids: fixtures.map((l) => l.id) }, parameters: { on: intent.on } });
    }

    case "replace_object": {
      const found = pieces(resolve(intent.target));
      if (!("objects" in found)) return found;
      const object = found.objects[0];
      const request: ReplacementRequest = { kind: "replace-object", targetObjectId: object.id, targetLabel: object.label, requestedForm: intent.form, requestedAttributes: intent.attributes };
      if (alreadyIs(object, request)) return { ok: false, outcome: "unavailable", message: MESSAGES.nothingChanges, already: true };
      if (!fulfil(object, request)) return unavailable(MESSAGES.replacementUnavailable, request);
      return done({ type: "REPLACE_OBJECT", target: { kind: "object", id: object.id }, parameters: { form: intent.form, attributes: intent.attributes } });
    }
  }
}

/** The relations a move is made in; into, onto and under are answered by `impossiblePlace`. */
const WAYS: Partial<Record<MoveRelation, MoveWay>> = {
  closer_to: "toward",
  away_from: "away",
  beside: "beside",
  in_front_of: "in_front_of",
  behind: "behind",
  above: "above",
  against: "against",
};

/** A single thing a move or a turn is measured against: a piece, the nearest opening, or the nearest wall. */
function placeRef(scene: Scene, r: Resolved, mover: SceneObject, how: string): PlaceRef | Resolution {
  if (r.kind === "clarify") return clarify(r.clarification, r.message);
  if (r.kind === "missing") return refuse(r.message);
  if (r.kind === "objects") {
    if (r.objects.length > 1) return clarify({ reason: "ambiguous", options: describeAmong(scene, r.objects) }, `Which one — ${listOf(r.objects.map((o) => o.label.toLowerCase()))}?`);
    return { kind: "object", id: r.objects[0].id };
  }
  if (r.kind === "openings") return { kind: "opening", id: nearestOpening(scene, r.openings, mover).id };
  if (r.kind === "surfaces" && r.surface === "walls") {
    const wall = nearestWall(scene, mover.transform.position);
    if (wall) return { kind: "wall", id: wall.id };
  }
  return refuse(`I can turn or move a piece ${how} another piece, a window, a door or a wall, not the ${r.kind === "surfaces" ? r.label.toLowerCase() : r.kind === "room" ? "room" : "lights"}.`);
}

/** Places no piece can go: inside a surface or another piece, on the ceiling, under something. */
function impossiblePlace(object: SceneObject, relation: MoveRelation, r: Resolved): Resolution | null {
  const name = object.label.toLowerCase();
  const stands = object.support.kind === "wall" ? "hangs on a wall" : "stands on the floor";
  if (relation === "into") {
    if (r.kind === "surfaces") return refuse(`The ${name} can’t go inside the ${r.label.toLowerCase()}: a piece ${object.support.kind === "wall" ? "hangs on a wall" : "stands on the floor or hangs on a wall"}, never inside one.`);
    if (r.kind === "openings") return refuse(`The ${name} can’t go inside the ${r.label.toLowerCase()}. I can move it closer to it instead — try “move the ${name} closer to the ${r.label.toLowerCase()}”.`);
    if (r.kind === "objects") return unavailable(`Putting the ${name} inside the ${r.objects[0].label.toLowerCase()} isn’t something this room model can do.`);
    if (r.kind === "room") return unavailable(`The ${name} is already in the room.`);
  }
  if (relation === "onto") {
    if (r.kind === "surfaces" && r.surface === "floor") return object.support.kind === "floor" ? unavailable(`The ${name} already stands on the floor.`) : refuse(`The ${name} ${stands}; it doesn’t go on the floor.`);
    if (r.kind === "surfaces") return refuse(`The ${name} can’t go on the ${r.label.toLowerCase()}: it ${stands}.`);
    if (r.kind === "objects") return unavailable(`Putting a piece on top of another isn’t available yet.`);
  }
  if (relation === "under") {
    if (r.kind === "objects") return unavailable("Putting a piece under another isn’t available yet.");
    if (r.kind === "surfaces") return refuse(`The ${name} can’t go under the ${r.label.toLowerCase()}.`);
  }
  if (relation === "above" && r.kind === "surfaces") return refuse(`The ${name} can’t go above the ${r.label.toLowerCase()}.`);
  return null;
}

/** "Make the TV liquid": refused with what the piece can be made of. */
function notAFinish(scene: Scene, r: Resolved, word: string) {
  if (r.kind === "surfaces") {
    const kind = r.surface === "walls" ? "wall" : r.surface;
    return `The ${r.label.toLowerCase()} can’t be made ${word}. ${capital(r.label.toLowerCase())} here can be ${allowedFor(`surface.${kind}`) ?? "repainted or refinished"}.`;
  }
  if (r.kind !== "objects") return `Nothing in a room can be made ${word}.`;
  const object = r.objects[0];
  const slot = primarySlot(object);
  const can = slot ? allowedFor(`${object.category}.${slot}`) : null;
  return `A ${object.label.toLowerCase().replace(/\s\d+$/, "")} can’t be made ${word}${can ? `: its ${slot} can be ${can}` : ""}. I can change its colour or its finish, not what it is made into.`;
}

const allowedFor = (key: string) => (ALLOWED_CLASSES[key] ? ALLOWED_CLASSES[key].join(", ").replace(/, ([^,]*)$/, " or $1") : null);

function nearestOpening(scene: Scene, openings: readonly Opening[], object: SceneObject): Opening {
  return [...openings].sort((a, b) => gapTo(scene, object, a) - gapTo(scene, object, b))[0];
}

function fixtureOf(scene: Scene, object: SceneObject) {
  return scene.lights.find((l): l is ArtificialLight => l.kind === "artificial" && l.fixtureId === object.id);
}

const lampsIn = (scene: Scene) => scene.lights.filter((l): l is ArtificialLight => l.kind === "artificial" && scene.objects.some((o) => o.id === l.fixtureId));

/** The words as the person typed them, when the reader lower-cased them: “Mars”, not “mars”. */
function asTyped(text: string, words: string) {
  const at = text.toLowerCase().indexOf(words);
  return at >= 0 ? text.slice(at, at + words.length) : words;
}

const phrase = (p: NearPredicate) => (p === "in-front-of" ? "in front of" : p === "lit-by" ? "lit by" : p === "faces" ? "facing" : p);

const singular = (ref: ObjectRef) => (ref.plural ? ref.words.replace(/(?:es|s)$/, "") : ref.words);
const pluralWord = (ref: ObjectRef) => {
  if (ref.plural) return ref.words;
  const w = ref.words;
  if (/(?:ch|sh|s|x)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const listOf = (items: readonly string[]) =>
  items.length <= 1 ? `the ${items[0] ?? ""}` : `the ${items.slice(0, -1).join(", the ")} or the ${items[items.length - 1]}`;
