import { timeOfDay, type SceneOperation } from "@/scene/model/operations";
import { findById, objectCenter, openingCenter, walls } from "@/scene/model/queries";
import type { ArtificialLight, Hex, Id, Material, Scene, SceneObject, Surface, Vec3, WallSurface } from "@/scene/model/types";
import { alreadyIs, fulfil } from "../../assets/catalogue";
import { adjust, moveObject, rotateObject } from "../../state/edits";
import type {
  Clarification,
  CommandIntent,
  InterpretationResult,
  ProposedChange,
  ReplacementRequest,
} from "../interpreter";
import { ALL_LAMPS, COLOURS, OBJECT_NAMES, OPENING_NAMES, ROOM_WORDS, SELECTION_WORDS, SURFACE_NAMES } from "./vocabulary";

/**
 * Turning an intent into scene operations.
 *
 * The target is resolved against the scene first — by name, by alias, or
 * as "this" — and a command that cannot be resolved without guessing asks
 * instead. Every change is then the same kind of operation a hand makes, so
 * it is previewed, applied, listed in the history and undone by machinery
 * that already exists. Nothing writes to the renderer.
 *
 * A change that would alter nothing is dropped rather than shown, so a
 * proposal never offers something that does nothing.
 */

/** How far along the gap "closer" travels, and how far "away" pushes out. */
const CLOSER = 0.45;
const AWAY = 0.35;
/** Steps a command takes, chosen to be clearly visible but not violent. */
const HOUR_STEP = 0.18;
const KELVIN_STEP = 500;
const TONE_STEP = 0.16;
const OUTPUT_STEP = 1.4;

export interface PlanContext {
  scene: Scene;
  /** The scene as it was opened, for "reset". */
  original: Scene;
  selectionId: Id | null;
}

/** What the person is told, in product language rather than parser language. */
export const MESSAGES = {
  notUnderstood:
    "I couldn’t turn that into a change to this room. Try “make the sofa darker”, “rotate this 30 degrees” or “warm up the room”.",
  unavailable: "I understand the request, but that edit isn’t available yet.",
  replacementUnavailable: "I can understand the replacement request, but this furniture asset isn’t available yet.",
  whichObject: "Which object should I change? Select it in the room, or name it.",
  whereTo: "Where should it go? Try “closer to the window” or “away from the wall”.",
  nothingChanges: "That’s already the case, so there’s nothing to change.",
} as const;

export function plan(intent: CommandIntent, context: PlanContext, command: string): InterpretationResult {
  const { scene } = context;
  const present = (summary: string, changes: ProposedChange[]): InterpretationResult =>
    changes.length === 0
      ? { outcome: "unavailable", message: MESSAGES.nothingChanges, command, intent }
      : { outcome: "changes", interpretation: { command, summary, changes, intent } };
  const clarify = (clarification: Clarification, message: string): InterpretationResult => ({
    outcome: "clarify",
    message,
    intent: { ...intent, clarificationRequired: clarification },
  });
  const unavailable = (message: string = MESSAGES.unavailable): InterpretationResult => ({
    outcome: "unavailable",
    message,
    command,
    intent,
  });

  if (intent.intent === "reset") return present("Back to the room as it was opened.", planReset(context));
  if (intent.intent === "unavailable") return unavailable();

  const target = resolve(intent, context);
  if (target.kind === "clarify") return clarify(target.clarification, target.message);
  if (target.kind === "missing") {
    return { outcome: "unsupported", message: `There’s no ${target.phrase} in this room.` };
  }

  const p = intent.parameters;
  switch (intent.intent) {
    case "warmth": {
      const direction = p.direction === -1 ? -1 : 1;
      const word = direction > 0 ? "warmer" : "cooler";
      if (target.kind === "room" || target.kind === "lamps") {
        const lightingOnly = target.kind === "lamps" || p.lighting === true;
        return present(warmthSummary(direction, lightingOnly), planRoomWarmth(scene, direction, lightingOnly));
      }
      if (target.kind === "object") {
        const lamp = fixtureOf(scene, target.object);
        return lamp
          ? present(`${target.object.label}, ${word} light.`, planLampWarmth(lamp, target.object.label, direction))
          : present(`${target.object.label}, ${word}.`, planObjectTone(scene, target.object, direction > 0 ? "warm" : "cool"));
      }
      if (target.kind === "surface") {
        return present(`${target.label}, ${word}.`, planSurfaceTone(scene, target, direction > 0 ? "warm" : "cool"));
      }
      return unavailable();
    }

    case "brightness": {
      const direction = p.direction === -1 ? -1 : 1;
      if (target.kind === "room" || target.kind === "lamps") {
        return present(direction > 0 ? "More light in the room." : "Less light in the room.", planRoomBrightness(scene, direction));
      }
      if (target.kind === "object") {
        const lamp = fixtureOf(scene, target.object);
        return lamp
          ? present(`${target.object.label}, ${direction > 0 ? "brighter" : "dimmer"}.`, planLampOutput(lamp, target.object.label, direction))
          : present(`${target.object.label}, ${direction > 0 ? "lighter" : "darker"}.`, planObjectTone(scene, target.object, direction > 0 ? "lighter" : "darker"));
      }
      if (target.kind === "surface") {
        return present(`${target.label}, ${direction > 0 ? "lighter" : "darker"}.`, planSurfaceTone(scene, target, direction > 0 ? "lighter" : "darker"));
      }
      return unavailable();
    }

    case "tone": {
      const tone = p.tone === "lighter" ? "lighter" : "darker";
      if (target.kind === "room") {
        return present(tone === "lighter" ? "More light in the room." : "Less light in the room.", planRoomBrightness(scene, tone === "lighter" ? 1 : -1));
      }
      if (target.kind === "object") return present(`${target.object.label}, ${tone}.`, planObjectTone(scene, target.object, tone));
      if (target.kind === "surface") return present(`${target.label}, ${tone}.`, planSurfaceTone(scene, target, tone));
      return unavailable();
    }

    case "recolour": {
      const name = String(p.colour);
      const hex = COLOURS[name];
      if (target.kind === "object") return present(`${target.object.label}, ${name}.`, planObjectColour(scene, target.object, name, hex));
      if (target.kind === "surface") return present(`${target.label}, ${name}.`, planSurfaceColour(scene, target, name, hex));
      if (target.kind === "room") return clarify({ reason: "no-target" }, MESSAGES.whichObject);
      return unavailable();
    }

    case "rotate": {
      if (target.kind !== "object") return clarify({ reason: "no-target" }, MESSAGES.whichObject);
      const degrees = Number(p.degrees);
      return present(`${target.object.label}, turned ${Math.abs(degrees)}°.`, [rotation(scene, target.object, degrees)]);
    }

    case "size": {
      if (target.kind !== "object") {
        return target.kind === "room" ? clarify({ reason: "no-target" }, MESSAGES.whichObject) : unavailable();
      }
      const factor = Number(p.factor);
      return present(`${target.object.label}, ${factor > 1 ? "larger" : "smaller"}.`, [resize(target.object, factor)]);
    }

    case "move": {
      if (target.kind !== "object") {
        return target.kind === "room" ? clarify({ reason: "no-target" }, MESSAGES.whichObject) : unavailable();
      }
      if (p.relation === "none" || !p.reference) return clarify({ reason: "no-reference" }, MESSAGES.whereTo);
      const destination = resolveReference(scene, String(p.reference), target.object);
      if (destination.kind === "ambiguous") {
        return clarify(
          { reason: "ambiguous", options: destination.options },
          `Towards which one — ${list(destination.options)}?`,
        );
      }
      if (destination.kind === "missing") {
        return { outcome: "unsupported", message: `There’s no ${p.reference} in this room to move it towards.` };
      }
      const relation = p.relation === "away" ? "away" : "closer";
      return present(
        `${target.object.label}, ${relation === "closer" ? "closer to" : "further from"} the ${destination.label.toLowerCase()}.`,
        [displacement(scene, target.object, destination.point, relation)],
      );
    }

    case "switch": {
      const fixtures =
        target.kind === "lamps"
          ? target.lamps
          : target.kind === "object"
            ? [fixtureOf(scene, target.object)].filter((l): l is ArtificialLight => l !== undefined)
            : [];
      if (fixtures.length === 0) {
        return target.kind === "room"
          ? clarify({ reason: "no-target" }, "Which light should I switch?")
          : unavailable("That isn’t a light this room can switch.");
      }
      const on = p.on === true;
      const label = fixtures.length > 1 ? "Lamps" : fixtures[0].label;
      return present(`${label}, ${on ? "on" : "off"}.`, [
        {
          id: "switch",
          group: "Lighting",
          target: label,
          detail: on ? "switched on" : "switched off",
          operations: fixtures.map((lamp): SceneOperation => ({ kind: "relight", lightId: lamp.id, to: { on } })),
        },
      ]);
    }

    case "replace": {
      if (target.kind !== "object") return clarify({ reason: "no-target" }, MESSAGES.whichObject);
      const request: ReplacementRequest = {
        kind: "replace-object",
        targetObjectId: target.object.id,
        targetLabel: target.object.label,
        requestedForm: String(p.requestedForm),
        requestedAttributes: Array.isArray(p.requestedAttributes) ? p.requestedAttributes : [],
      };
      if (alreadyIs(target.object, request)) return unavailable(MESSAGES.nothingChanges);
      const built = fulfil(target.object, request);
      if (!built) {
        return { outcome: "unavailable", message: MESSAGES.replacementUnavailable, command, intent, request };
      }
      return present(`${target.object.label}, as a ${built.label}.`, [
        {
          id: "replace",
          group: "Furniture",
          target: target.object.label,
          detail: `replaced with a ${built.label}`,
          operations: [built.operation],
        },
      ]);
    }
  }
  return unavailable();
}

// ---------------------------------------------------------------------------
// Resolving what a command is about

type SurfaceTarget = { kind: "surface"; label: string; surfaces: readonly Surface[] };

type Resolved =
  | { kind: "room" }
  | { kind: "object"; object: SceneObject }
  | SurfaceTarget
  | { kind: "opening"; label: string }
  | { kind: "lamps"; lamps: readonly ArtificialLight[] }
  | { kind: "clarify"; clarification: Clarification; message: string }
  | { kind: "missing"; phrase: string };

/** Every name a piece answers to: its label, its category, and the vocabulary's aliases. */
function namesOf(object: SceneObject) {
  return [object.label.toLowerCase(), object.category.replace(/-/g, " "), ...(OBJECT_NAMES[object.category] ?? [])];
}

/**
 * The pieces a phrase names. The longest name wins, so "coffee table" beats
 * "table"; when a generic word still fits several pieces, all are returned
 * and the caller asks which.
 */
function piecesNamed(scene: Scene, phrase: string): SceneObject[] {
  let best = 0;
  let found: SceneObject[] = [];
  for (const object of scene.objects) {
    const length = Math.max(0, ...namesOf(object).filter((name) => has(phrase, name)).map((name) => name.length));
    if (length === 0 || length < best) continue;
    if (length > best) {
      best = length;
      found = [];
    }
    found.push(object);
  }
  return found;
}

function resolve(intent: CommandIntent, { scene, selectionId }: PlanContext): Resolved {
  const selected = selectionId ? findById(scene.objects, selectionId) : undefined;
  const target = intent.target;
  const roomCanTakeIt = intent.intent === "warmth" || intent.intent === "brightness" || intent.intent === "tone";

  if (target.kind === "room") return { kind: "room" };
  if (target.kind === "selection") {
    if (selected) return { kind: "object", object: selected };
    // "it" can fall back to the room for changes the room can take; "this" points.
    if (target.word === "it" && roomCanTakeIt) return { kind: "room" };
    return { kind: "clarify", clarification: { reason: "no-selection" }, message: MESSAGES.whichObject };
  }
  if (target.kind === "unspecified") {
    if (selected) return { kind: "object", object: selected };
    if (roomCanTakeIt) return { kind: "room" };
    return { kind: "clarify", clarification: { reason: "no-target" }, message: MESSAGES.whichObject };
  }

  const phrase = target.phrase;
  const lightingIntent = intent.intent === "warmth" || intent.intent === "brightness" || intent.intent === "switch";
  if (lightingIntent && ALL_LAMPS.test(phrase)) {
    return { kind: "lamps", lamps: scene.lights.filter((l): l is ArtificialLight => l.kind === "artificial") };
  }

  const pieces = piecesNamed(scene, phrase);
  if (pieces.length === 1) return { kind: "object", object: pieces[0] };
  if (pieces.length > 1) {
    if (selected && pieces.includes(selected)) return { kind: "object", object: selected };
    const noun = genericNoun(phrase, pieces) ?? "one";
    const options = pieces.map((o) => o.label.toLowerCase());
    return {
      kind: "clarify",
      clarification: { reason: "ambiguous", options },
      message: `Which ${noun} should I change — ${list(options)}?`,
    };
  }

  if (SURFACE_NAMES.wall.test(phrase)) return { kind: "surface", label: "Walls", surfaces: walls(scene) };
  if (SURFACE_NAMES.floor.test(phrase)) {
    return { kind: "surface", label: "Floor", surfaces: scene.surfaces.filter((s) => s.kind === "floor") };
  }
  if (SURFACE_NAMES.ceiling.test(phrase)) {
    return { kind: "surface", label: "Ceiling", surfaces: scene.surfaces.filter((s) => s.kind === "ceiling") };
  }
  if (OPENING_NAMES.window.test(phrase)) return { kind: "opening", label: "Windows" };
  if (OPENING_NAMES.door.test(phrase)) return { kind: "opening", label: "Door" };
  if (ROOM_WORDS.test(phrase)) return { kind: "room" };
  if (SELECTION_WORDS.test(phrase)) {
    return selected
      ? { kind: "object", object: selected }
      : { kind: "clarify", clarification: { reason: "no-selection" }, message: MESSAGES.whichObject };
  }
  return { kind: "missing", phrase: phrase.replace(/^(?:the|a|an|my)\s+/, "") };
}

/** The shared word several pieces answered to, for asking which one. */
function genericNoun(phrase: string, pieces: readonly SceneObject[]) {
  const shared = namesOf(pieces[0]).filter(
    (name) => pieces.every((piece) => namesOf(piece).includes(name)) && has(phrase, name),
  );
  return shared.sort((a, b) => b.length - a.length)[0];
}

/** Somewhere in the room to move towards or away from. */
function resolveReference(
  scene: Scene,
  text: string,
  mover: SceneObject,
): { kind: "point"; label: string; point: Vec3 } | { kind: "ambiguous"; options: string[] } | { kind: "missing" } {
  const from = mover.transform.position;

  // Openings first, and the nearest one when a room has several.
  const kind = OPENING_NAMES.window.test(text) ? "window" : OPENING_NAMES.door.test(text) ? "door" : null;
  const openings = kind ? scene.openings.filter((o) => o.kind === kind) : [];
  if (openings.length > 0) {
    const nearest = openings
      .map((o) => ({ opening: o, point: openingCenter(scene, o) }))
      .sort((a, b) => distance(from, a.point) - distance(from, b.point))[0];
    return { kind: "point", label: nearest.opening.label, point: nearest.point };
  }

  const named = walls(scene).find((w) => has(text, w.label.toLowerCase()));
  const wall = named ?? (SURFACE_NAMES.wall.test(text) ? nearestWall(scene, from) : undefined);
  if (wall) {
    return {
      kind: "point",
      label: wall.label,
      point: [(wall.start[0] + wall.end[0]) / 2, from[1], (wall.start[1] + wall.end[1]) / 2],
    };
  }

  const pieces = piecesNamed(scene, text).filter((o) => o.id !== mover.id);
  if (pieces.length === 1) return { kind: "point", label: pieces[0].label, point: objectCenter(pieces[0]) };
  if (pieces.length > 1) return { kind: "ambiguous", options: pieces.map((o) => o.label.toLowerCase()) };
  return { kind: "missing" };
}

function nearestWall(scene: Scene, from: Vec3) {
  const midpoint = (w: WallSurface): Vec3 => [
    (w.start[0] + w.end[0]) / 2,
    from[1],
    (w.start[1] + w.end[1]) / 2,
  ];
  return [...walls(scene)].sort((a, b) => distance(from, midpoint(a)) - distance(from, midpoint(b)))[0];
}

function fixtureOf(scene: Scene, object: SceneObject) {
  return scene.lights.find((l): l is ArtificialLight => l.kind === "artificial" && l.fixtureId === object.id);
}

// ---------------------------------------------------------------------------
// Plans

function planRoomWarmth(scene: Scene, direction: 1 | -1, lightingOnly: boolean): ProposedChange[] {
  const changes: ProposedChange[] = [];
  const daylight = scene.lights.find((l) => l.kind === "daylight");
  if (daylight) {
    const to = clamp01(timeOfDay(scene) + direction * HOUR_STEP);
    if (to !== timeOfDay(scene)) {
      changes.push({
        id: "hour",
        group: "Lighting",
        target: "Daylight",
        detail: direction > 0 ? "warmer, later-afternoon sun" : "cooler, higher sun",
        operations: [{ kind: "relight", lightId: daylight.id, to: { timeOfDay: to } }],
      });
    }
  }

  const lamps = scene.lights.filter((l): l is ArtificialLight => l.kind === "artificial");
  const relit = lamps
    .map((lamp): SceneOperation | null => {
      const to = clamp(lamp.colorTemperature - direction * KELVIN_STEP, 1800, 6500);
      return to === lamp.colorTemperature ? null : { kind: "relight", lightId: lamp.id, to: { colorTemperature: to } };
    })
    .filter((op): op is SceneOperation => op !== null);
  if (relit.length > 0) {
    changes.push({
      id: "bulbs",
      group: "Lighting",
      target: lamps.length > 1 ? "Lamps" : lamps[0].label,
      detail: direction > 0 ? "warmer bulbs" : "cooler bulbs",
      operations: relit,
    });
  }
  if (lightingOnly) return changes;

  const tint: Hex = direction > 0 ? "#e8d6b8" : "#d5dee6";
  const painted = walls(scene)
    .map((wall): SceneOperation | null => {
      const base = findById(scene.materials, wall.materialId);
      if (!base) return null;
      const color = mixHex(base.color, tint, TONE_STEP);
      if (color === base.color) return null;
      return { kind: "resurface", surfaceId: wall.id, to: adjust(base, wall.id, "surface", { color }) };
    })
    .filter((op): op is SceneOperation => op !== null);
  if (painted.length > 0) {
    changes.push({
      id: "walls",
      group: "Surfaces",
      target: "Walls",
      detail: direction > 0 ? "a warmer neutral" : "a cooler neutral",
      operations: painted,
    });
  }
  return changes;
}

function planRoomBrightness(scene: Scene, direction: 1 | -1): ProposedChange[] {
  const changes: ProposedChange[] = [];
  const daylight = scene.lights.find((l) => l.kind === "daylight");
  if (daylight) {
    // The hour runs midday → night, so more light means an earlier hour.
    const to = clamp01(timeOfDay(scene) - direction * 0.25);
    if (to !== timeOfDay(scene)) {
      changes.push({
        id: "hour",
        group: "Lighting",
        target: "Daylight",
        detail: direction > 0 ? "a higher sun" : "a later hour",
        operations: [{ kind: "relight", lightId: daylight.id, to: { timeOfDay: to } }],
      });
    }
  }
  const lamps = scene.lights.filter((l): l is ArtificialLight => l.kind === "artificial");
  const output = lamps.map((lamp) => lampOutput(lamp, direction)).filter((op): op is SceneOperation => op !== null);
  if (output.length > 0) {
    changes.push({
      id: "output",
      group: "Lighting",
      target: lamps.length > 1 ? "Lamps" : lamps[0].label,
      detail: direction > 0 ? "turned up" : "turned down",
      operations: output,
    });
  }
  return changes;
}

function lampOutput(lamp: ArtificialLight, direction: 1 | -1): SceneOperation | null {
  const from = lamp.intensity ?? 1;
  const to = round2(clamp(direction > 0 ? from * OUTPUT_STEP : from / OUTPUT_STEP, 0, 3));
  return to === from ? null : { kind: "relight", lightId: lamp.id, to: { intensity: to } };
}

function planLampOutput(lamp: ArtificialLight, label: string, direction: 1 | -1): ProposedChange[] {
  const operation = lampOutput(lamp, direction);
  return operation
    ? [{ id: "output", group: "Lighting", target: label, detail: direction > 0 ? "turned up" : "turned down", operations: [operation] }]
    : [];
}

function planLampWarmth(lamp: ArtificialLight, label: string, direction: 1 | -1): ProposedChange[] {
  const to = clamp(lamp.colorTemperature - direction * KELVIN_STEP, 1800, 6500);
  if (to === lamp.colorTemperature) return [];
  return [
    {
      id: "bulb",
      group: "Lighting",
      target: label,
      detail: `${direction > 0 ? "warmer" : "cooler"} bulb, ${to} K`,
      operations: [{ kind: "relight", lightId: lamp.id, to: { colorTemperature: to } }],
    },
  ];
}

type Tone = "warm" | "cool" | "lighter" | "darker";

function planObjectTone(scene: Scene, object: SceneObject, tone: Tone): ProposedChange[] {
  const slot = primarySlot(object);
  const base = slot ? findById(scene.materials, object.materials[slot]) : undefined;
  return slot && base ? restyled(object, slot, base, shift(base.color, tone), `${slot} ${describe(tone)}`) : [];
}

function planObjectColour(scene: Scene, object: SceneObject, name: string, hex: Hex): ProposedChange[] {
  const slot = primarySlot(object);
  const base = slot ? findById(scene.materials, object.materials[slot]) : undefined;
  return slot && base ? restyled(object, slot, base, hex, `${slot} in ${name}`) : [];
}

function restyled(object: SceneObject, slot: string, base: Material, color: Hex, detail: string): ProposedChange[] {
  if (color.toLowerCase() === base.color.toLowerCase()) return [];
  return [
    {
      id: "tone",
      group: "Materials",
      target: object.label,
      detail,
      operations: [{ kind: "restyle", objectId: object.id, slot, to: adjust(base, object.id, slot, { color }) }],
    },
  ];
}

function planSurfaceTone(scene: Scene, target: SurfaceTarget, tone: Tone): ProposedChange[] {
  return resurfaced(scene, target, (color) => shift(color, tone), describe(tone));
}

function planSurfaceColour(scene: Scene, target: SurfaceTarget, name: string, hex: Hex): ProposedChange[] {
  return resurfaced(scene, target, () => hex, `painted ${name}`);
}

function resurfaced(scene: Scene, target: SurfaceTarget, recolour: (color: Hex) => Hex, detail: string): ProposedChange[] {
  const operations = target.surfaces
    .map((surface): SceneOperation | null => {
      const base = findById(scene.materials, surface.materialId);
      if (!base) return null;
      const color = recolour(base.color);
      if (color.toLowerCase() === base.color.toLowerCase()) return null;
      return { kind: "resurface", surfaceId: surface.id, to: adjust(base, surface.id, "surface", { color }) };
    })
    .filter((op): op is SceneOperation => op !== null);
  return operations.length ? [{ id: "surface", group: "Surfaces", target: target.label, detail, operations }] : [];
}

function planReset({ scene, original }: PlanContext): ProposedChange[] {
  const placement: SceneOperation[] = [];
  const finishes: SceneOperation[] = [];
  const light: SceneOperation[] = [];

  original.objects.forEach((was, index) => {
    const now = findById(scene.objects, was.id);
    if (!now) {
      placement.push({ kind: "add", object: was, index });
      return;
    }
    // A piece given a different form goes back to the one it had.
    if (now.form !== was.form || now.category !== was.category) {
      placement.push({ kind: "replace", objectId: was.id, replacement: was });
    }
    placement.push({ kind: "move", objectId: was.id, to: was.transform.position, rotationY: was.transform.rotation[1] });
    placement.push({ kind: "scale", objectId: was.id, to: was.transform.scale });
    for (const [slot, id] of Object.entries(was.materials)) {
      const material = findById(original.materials, id);
      if (material) finishes.push({ kind: "restyle", objectId: was.id, slot, to: material });
    }
  });
  for (const now of scene.objects) {
    if (!findById(original.objects, now.id)) placement.push({ kind: "remove", objectId: now.id });
  }
  for (const was of original.surfaces) {
    const material = findById(original.materials, was.materialId);
    if (material) finishes.push({ kind: "resurface", surfaceId: was.id, to: material });
  }
  for (const was of original.lights) {
    if (was.kind === "daylight") {
      light.push({ kind: "relight", lightId: was.id, to: { timeOfDay: was.timeOfDay ?? 0 } });
    } else if (was.kind === "artificial") {
      light.push({
        kind: "relight",
        lightId: was.id,
        to: { colorTemperature: was.colorTemperature, intensity: was.intensity ?? 1, on: was.on === undefined ? "auto" : was.on },
      });
    }
  }

  return [
    { id: "placement", group: "Furniture", target: "Objects", detail: "back where they stood", operations: placement },
    { id: "finishes", group: "Materials", target: "Materials", detail: "back to their finishes", operations: finishes },
    { id: "light", group: "Lighting", target: "Light", detail: "back to the hour it opened at", operations: light },
  ];
}

// ---------------------------------------------------------------------------
// Operations
//
// Moves and turns go through the same intents a hand uses, so a command is
// held to the room's walls and carries what stands on the piece, exactly as
// a drag would.

function rotation(scene: Scene, object: SceneObject, degrees: number): ProposedChange {
  const to = object.transform.rotation[1] + (degrees * Math.PI) / 180;
  return {
    id: "rotate",
    group: "Furniture",
    target: object.label,
    detail: `turned ${Math.abs(Math.round(degrees))}° ${degrees < 0 ? "anticlockwise" : "clockwise"}`,
    operations: rotateObject(scene, object, to).operations,
  };
}

function resize(object: SceneObject, factor: number): ProposedChange {
  const [sx, sy, sz] = object.transform.scale;
  return {
    id: "size",
    group: "Furniture",
    target: object.label,
    detail: `${factor > 1 ? "larger" : "smaller"} by ${Math.round(Math.abs(factor - 1) * 100)}%`,
    operations: [
      { kind: "scale", objectId: object.id, to: [round2(sx * factor), round2(sy * factor), round2(sz * factor)] },
    ],
  };
}

function displacement(scene: Scene, object: SceneObject, point: Vec3, relation: "closer" | "away"): ProposedChange {
  const from = object.transform.position;
  const share = relation === "closer" ? CLOSER : -AWAY;
  const to: Vec3 = [
    round2(from[0] + (point[0] - from[0]) * share),
    from[1],
    round2(from[2] + (point[2] - from[2]) * share),
  ];
  return {
    id: "move",
    group: "Furniture",
    target: object.label,
    detail: relation === "closer" ? "moved closer" : "moved away",
    operations: moveObject(scene, object, to).operations,
  };
}

// ---------------------------------------------------------------------------

/** The slot that reads as the piece's own colour. */
const SLOT_ORDER = ["upholstery", "cover", "surface", "top", "body", "pile", "weave", "shade", "seat"];

function primarySlot(object: SceneObject): string | undefined {
  const slots = Object.keys(object.materials);
  return SLOT_ORDER.find((slot) => slots.includes(slot)) ?? slots[0];
}

const describe = (tone: Tone) =>
  tone === "warm" ? "warmed" : tone === "cool" ? "cooled" : tone === "lighter" ? "lightened" : "darkened";

function shift(color: Hex, tone: Tone): Hex {
  if (tone === "warm") return mixHex(color, "#e8b878", TONE_STEP);
  if (tone === "cool") return mixHex(color, "#9fb6c8", TONE_STEP);
  return scaleHex(color, tone === "lighter" ? 1.22 : 0.74);
}

/** "the coffee table or the side table" */
const list = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `the ${items.slice(0, -1).join(", the ")} or the ${items[items.length - 1]}`;

const has = (text: string, word: string) =>
  new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);

// Colour --------------------------------------------------------------------

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const toHex = (rgb: readonly number[]): Hex =>
  `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;

const mixHex = (from: Hex, towards: string, amount: number): Hex => {
  const a = channels(from);
  const b = channels(towards);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
};

const scaleHex = (from: Hex, factor: number): Hex => toHex(channels(from).map((v) => v * factor));

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => round2(clamp(value, 0, 1));
const round2 = (value: number) => Number(value.toFixed(2));
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const warmthSummary = (direction: 1 | -1, lightingOnly: boolean) =>
  lightingOnly
    ? direction > 0
      ? "Warmer light: a later sun and warmer bulbs."
      : "Cooler light: a higher sun and cooler bulbs."
    : direction > 0
      ? "A warmer room: later light, warmer bulbs, warmer walls."
      : "A cooler room: higher light, cooler bulbs, cooler walls.";
