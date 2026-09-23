import { CLASS_DEFAULTS, colourName } from "@/scene/compile/materials";
import { mixHex, scaleHex } from "@/scene/model/colour";
import { applyOperation, hourName, moveWithLoad, timeOfDay, type SceneOperation } from "@/scene/model/operations";
import { findById, objectCenter, openingCenter, walls } from "@/scene/model/queries";
import type { ArtificialLight, Hex, Id, Material, MaterialClass, Scene, SceneObject, Surface, Vec3, WallSurface } from "@/scene/model/types";
import { fulfil } from "../../assets/catalogue";
import { adjust, moveObject, removeObject, rotateObject } from "../../state/edits";
import { placeOf, SCALE_LIMITS, titleOf, validateCommand, type FinishChange, type PlaceRef, type StructuredCommand } from "../command";
import type { Degree, SceneIntent } from "../intent";
import type { InterpretationResult, ProposedChange } from "../interpreter";
import { MESSAGES } from "./messages";
import { resolveIntent } from "./resolve";
import { above, againstWall, beside, directional, facingAngle, footprintOf, inFrontOf, moveRelative, refusal, settle, type Placement, type Reference } from "./spatial";

export { MESSAGES } from "./messages";

/**
 * Turning an intent into scene operations.
 * ================================================================
 *
 *   SceneIntent → resolveIntent → StructuredCommand → validateCommand → compileCommand → ProposedChange[]
 *
 * The intent's references are found in the scene first (`resolve.ts`), and
 * one that cannot be found without guessing asks instead. The resulting
 * command — ids, not words — is checked against the scene (`command.ts`):
 * angles, sizes, finishes, that everything named exists. Only then is it
 * made into the same operations a hand makes, through the same edit
 * helpers (`state/edits.ts`), so it is previewed, applied, listed in the
 * history and undone by machinery that already exists. Nothing writes to
 * the renderer.
 *
 * A change that would alter nothing is dropped rather than shown, so a
 * proposal never offers something that does nothing. Everything here is a
 * pure function of the command and the scene: the same command on the same
 * scene always compiles to the same operations.
 */

/** Steps a command takes, chosen to be clearly visible but not violent. */
const HOUR_STEP = 0.18;
const DAYLIGHT_STEP = 0.25;
const KELVIN_STEP = 500;
const TONE = { slight: { mix: 0.08, darker: 0.87, lighter: 1.1 }, normal: { mix: 0.16, darker: 0.74, lighter: 1.22 }, strong: { mix: 0.28, darker: 0.6, lighter: 1.4 } } as const;
const OUTPUT_STEP = 1.4;

export interface CompileContext {
  scene: Scene;
  /** The scene as it was opened, for "reset". */
  original: Scene;
  selectionId: Id | null;
}

/** Words → operations, through every checked stage. */
export function compileIntent(intent: SceneIntent, context: CompileContext, command: string): InterpretationResult {
  const resolution = resolveIntent(intent, context.scene, context.selectionId, command);
  if (!resolution.ok) {
    if (resolution.outcome === "clarify") return { outcome: "clarify", message: resolution.message, intent, clarification: resolution.clarification };
    if (resolution.outcome === "unavailable") return { outcome: "unavailable", message: resolution.message, command, intent, ...(resolution.request && { request: resolution.request }), ...(resolution.already && { already: true as const }) };
    return { outcome: "unsupported", message: resolution.message, intent };
  }
  return compileStructured(resolution.command, context, command, intent);
}

/**
 * A structured command, checked and compiled. The one path from a command
 * to operations, whoever produced the command.
 */
export function compileStructured(structured: StructuredCommand, context: CompileContext, text: string, intent: SceneIntent): InterpretationResult {
  const checked = validateCommand(context.scene, structured);
  if (!checked.ok) return { outcome: "unsupported", message: sentence(checked.reason), intent };
  const planned = compileCommand(structured, context);
  if ("refused" in planned) return { outcome: "unsupported", message: planned.refused, intent };
  if ("already" in planned) return { outcome: "unavailable", message: planned.already, command: text, intent, already: true };
  if (planned.changes.length === 0) return { outcome: "unavailable", message: MESSAGES.nothingChanges, command: text, intent, already: true };
  return {
    outcome: "changes",
    interpretation: { command: text, title: titleOf(context.scene, structured), summary: planned.summary, changes: planned.changes, intent, structured },
  };
}

type Planned = { summary: string; changes: ProposedChange[] } | { refused: string } | { already: string };

/** A validated command, as operations. */
export function compileCommand(command: StructuredCommand, context: CompileContext): Planned {
  const { scene } = context;
  const object = (id: Id) => findById(scene.objects, id)!;
  const objects = (t: { kind: "object"; id: Id } | { kind: "objects"; ids: readonly Id[] }) => (t.kind === "object" ? [object(t.id)] : t.ids.map(object));

  switch (command.type) {
    case "RESET_ROOM":
      return { summary: "Back to the room as it was opened.", changes: planReset(context) };

    case "MOVE_OBJECT": {
      const mover = object(command.target.id);
      const p = command.parameters;
      const ref = p.reference;
      let placement: Placement;
      switch (p.direction) {
        case "toward":
        case "away":
          placement = moveRelative(scene, mover, referenceOf(scene, ref!), p.direction === "away", p.amount, p.distance);
          break;
        case "beside":
          placement = beside(scene, mover, object(ref!.id));
          break;
        case "in_front_of":
          placement = inFrontOf(scene, mover, object(ref!.id));
          break;
        case "behind":
          placement = inFrontOf(scene, mover, object(ref!.id), true);
          break;
        case "above":
          placement = above(scene, mover, object(ref!.id));
          break;
        case "against":
          placement = againstWall(scene, mover, ref ? (placeOf(scene, ref) as WallSurface) : null);
          break;
        default:
          placement = directional(scene, mover, p.direction, p.distance, p.amount);
      }
      if (placement.kind === "already") return { already: placement.message };
      if (placement.kind === "blocked") return { refused: placement.message };
      const operations = moveObject(scene, mover, placement.to).operations;
      const where = ref ? `the ${placeName(scene, ref)}` : "the wall";
      const way = { toward: `closer to ${where}`, away: `further from ${where}`, beside: `beside ${where}`, in_front_of: `in front of ${where}`, behind: `behind ${where}`, above: `above ${where}`, against: `against ${where}` } as Record<string, string>;
      const summary = `${mover.label}, ${way[p.direction] ?? (p.direction === "backward" ? "back" : p.direction)}.`;
      return { summary, changes: [{ id: "move", group: "Furniture", target: mover.label, detail: placement.note, operations }] };
    }

    case "ROTATE_OBJECT": {
      const changes: ProposedChange[] = [];
      const face = command.parameters.face;
      for (const piece of objects(command.target)) {
        let degrees = command.parameters.degrees;
        if (face) {
          const angle = facingAngle(piece, pointOf(scene, face, piece));
          if (angle === null) return { refused: `The ${piece.label.toLowerCase()} stands where the ${placeName(scene, face)} is; it can’t face it.` };
          // Clockwise from above is the negative turn about +Y, the short way round.
          degrees = round((-wrap(angle - piece.transform.rotation[1]) * 180) / Math.PI, 0.1);
          if (Math.abs(degrees) < 1) return { already: `The ${piece.label.toLowerCase()} already faces the ${placeName(scene, face)}.` };
        }
        const turned = planTurn(scene, piece, degrees!, face ? ` to face the ${placeName(scene, face)}` : "");
        if ("refused" in turned) return turned;
        changes.push(turned.change);
      }
      const names = listed(objects(command.target).map((o) => o.label));
      return { summary: face ? `${names}, turned to face the ${placeName(scene, face)}.` : `${names}, turned ${Math.abs(round(command.parameters.degrees!, 0.1))}°.`, changes };
    }

    case "SCALE_OBJECT": {
      const factor = command.parameters.factor;
      const changes: ProposedChange[] = [];
      for (const piece of objects(command.target)) {
        const planned = planScale(scene, piece, factor);
        if ("refused" in planned) return planned;
        if (planned.operations.length) {
          changes.push({ id: `size-${piece.id}`, group: "Furniture", target: piece.label, detail: `${factor > 1 ? "larger" : "smaller"} by ${Math.round(Math.abs(factor - 1) * 100)}%${planned.shifted ? `, shifted ${planned.shifted} to stay clear of ${planned.clear}` : ""}`, operations: planned.operations });
        }
      }
      return { summary: `${listed(objects(command.target).map((o) => o.label))}, ${factor > 1 ? "larger" : "smaller"}.`, changes };
    }

    case "REMOVE_OBJECT": {
      let working = scene;
      const changes: ProposedChange[] = [];
      for (const piece of objects(command.target)) {
        const edit = removeObject(working, piece);
        working = edit.operations.reduce(applyOperation, working);
        const carried = edit.operations.length - 1;
        changes.push({ id: `remove-${piece.id}`, group: "Furniture", target: piece.label, detail: carried > 0 ? `removed, with the ${carried} ${carried === 1 ? "piece" : "pieces"} on it` : "removed", operations: edit.operations });
      }
      return { summary: `${listed(objects(command.target).map((o) => o.label))}, taken away.`, changes };
    }

    case "CHANGE_MATERIAL": {
      const change = command.parameters.change;
      const t = command.target;
      if (t.kind === "surfaces") {
        const surfaces = t.ids.map((id) => findById(scene.surfaces, id)!);
        const label = t.surface === "walls" ? "Walls" : t.surface === "floor" ? "Floor" : "Ceiling";
        const changes =
          change.kind === "tone"
            ? resurfaced(scene, surfaces, label, (m) => ({ color: shift(m.color, change.tone, change.degree) }), describeTone(change.tone))
            : change.kind === "colour"
              ? resurfaced(scene, surfaces, label, () => ({ color: change.hex }), `painted ${change.name}`)
              : resurfaced(scene, surfaces, label, (m) => (m.class === change.material ? {} : classFinish(m, change.material)), `in ${change.material}`);
        return { summary: `${label}, ${describeChange(change)}.`, changes };
      }
      const changes: ProposedChange[] = [];
      for (const { objectId, slot } of t.slots) {
        const piece = object(objectId);
        const base = findById(scene.materials, piece.materials[slot])!;
        changes.push(...planSlot(piece, slot, base, change));
      }
      return { summary: `${listed([...new Set(t.slots.map((s) => object(s.objectId).label))])}, ${describeChange(change)}.`, changes };
    }

    case "CHANGE_LIGHTING": {
      const { change, includeSurfaces } = command.parameters;
      if (command.target.kind === "room") {
        if (change === "more_daylight" || change === "less_daylight") return planDaylight(scene, change === "more_daylight" ? 1 : -1);
        if (change === "warmer" || change === "cooler") {
          const direction = change === "warmer" ? 1 : -1;
          return { summary: warmthSummary(direction, !includeSurfaces), changes: planRoomWarmth(scene, direction, !includeSurfaces) };
        }
        const direction = change === "brighter" ? 1 : -1;
        return { summary: direction > 0 ? "More light in the room." : "Less light in the room.", changes: planRoomBrightness(scene, direction) };
      }
      const lamps = command.target.ids.map((id) => findById(scene.lights, id) as ArtificialLight);
      const changes = lamps.flatMap((lamp) => {
        const label = findById(scene.objects, lamp.fixtureId)!.label;
        return change === "warmer" || change === "cooler" ? planLampWarmth(lamp, label, change === "warmer" ? 1 : -1) : planLampOutput(lamp, label, change === "brighter" ? 1 : -1);
      });
      const what = lamps.length > 1 ? "Lamps" : findById(scene.objects, lamps[0].fixtureId)!.label;
      return { summary: `${what}, ${change === "warmer" || change === "cooler" ? `${change} light` : change}.`, changes };
    }

    case "SWITCH_LIGHT": {
      const fixtures = command.target.ids.map((id) => findById(scene.lights, id) as ArtificialLight);
      const label = fixtures.length > 1 ? "Lamps" : fixtures[0].label;
      const on = command.parameters.on;
      return {
        summary: `${label}, ${on ? "on" : "off"}.`,
        changes: [{ id: "switch", group: "Lighting", target: label, detail: on ? "switched on" : "switched off", operations: fixtures.map((lamp): SceneOperation => ({ kind: "relight", lightId: lamp.id, to: { on } })) }],
      };
    }

    case "REPLACE_OBJECT": {
      const piece = object(command.target.id);
      const built = fulfil(piece, { kind: "replace-object", targetObjectId: piece.id, targetLabel: piece.label, requestedForm: command.parameters.form, requestedAttributes: command.parameters.attributes });
      if (!built) return { refused: MESSAGES.replacementUnavailable };
      return { summary: `${piece.label}, as a ${built.label}.`, changes: [{ id: "replace", group: "Furniture", target: piece.label, detail: `replaced with a ${built.label}`, operations: [built.operation] }] };
    }
  }
}

// ---------------------------------------------------------------------------
// Where a piece goes

function referenceOf(scene: Scene, ref: PlaceRef): Reference {
  if (ref.kind === "object") return { kind: "object", object: findById(scene.objects, ref.id)! };
  if (ref.kind === "opening") return { kind: "opening", opening: findById(scene.openings, ref.id)! };
  return { kind: "wall", wall: placeOf(scene, ref) as WallSurface };
}

/** The point a reference stands for: a piece's centre, an opening's centre, the nearest point of a wall. */
function pointOf(scene: Scene, ref: PlaceRef, from: SceneObject): Vec3 {
  if (ref.kind === "object") return objectCenter(findById(scene.objects, ref.id)!);
  if (ref.kind === "opening") return openingCenter(scene, findById(scene.openings, ref.id)!);
  const w = placeOf(scene, ref) as WallSurface;
  const [x, , z] = from.transform.position;
  const dx = w.end[0] - w.start[0];
  const dz = w.end[1] - w.start[1];
  const t = Math.max(0, Math.min(1, ((x - w.start[0]) * dx + (z - w.start[1]) * dz) / (dx * dx + dz * dz || 1)));
  return [w.start[0] + dx * t, 0, w.start[1] + dz * t];
}

const placeName = (scene: Scene, ref: PlaceRef) => placeOf(scene, ref).label.toLowerCase();

// ---------------------------------------------------------------------------
// Turning

/**
 * Turn a piece by `degrees` (clockwise from above): in place and held
 * inside the room, as a hand's turn is, then — if that runs into something —
 * set down at the nearest free spot within 40 cm. Refused, with the largest
 * turn that fits, when there is none.
 */
function planTurn(scene: Scene, object: SceneObject, degrees: number, purpose: string): { change: ProposedChange } | { refused: string } {
  const to = object.transform.rotation[1] - (degrees * Math.PI) / 180;
  const lead = rotateObject(scene, object, to).operations[0];
  const at = lead.kind === "move" ? lead.to : object.transform.position;
  const why = refusal(scene, object, footprintOf(object, at, to));
  const settled = settle(scene, object, at, to);
  const way = degrees < 0 ? "anticlockwise" : "clockwise";
  if (!settled) {
    const fits = largestTurn(scene, object, degrees);
    return {
      refused:
        `Turning the ${object.label.toLowerCase()} ${Math.abs(round(degrees, 0.1))}°${purpose} would push it into ${why}, and there’s no free spot for it within 40 cm.` +
        (fits ? ` It can turn ${fits}° ${way} here — try “rotate the ${object.label.toLowerCase()} ${fits} degrees${degrees < 0 ? " anticlockwise" : ""}”.` : ""),
    };
  }
  // Said as the whole distance the piece travels: held off its wall, then clear of its neighbours.
  const [px, , pz] = object.transform.position;
  const held = Math.hypot(at[0] - px, at[2] - pz) >= 0.005;
  const moved = Math.round(Math.hypot(settled.at[0] - px, settled.at[2] - pz) * 100);
  const reasons = [held ? "stay inside the room" : null, settled.shift ? `clear ${why}` : null].filter(Boolean).join(" and ");
  const detail = `turned ${Math.abs(round(degrees, 0.1))}° ${way}${purpose}${moved ? `, moved ${moved} cm to ${reasons}` : ""}`;
  return { change: { id: `rotate-${object.id}`, group: "Furniture", target: object.label, detail, operations: moveWithLoad(scene, object, settled.at, to) } };
}

/** The largest turn in the asked direction, in 5° steps, that the room has space for; null if none. */
function largestTurn(scene: Scene, object: SceneObject, degrees: number): number | null {
  for (let d = Math.floor(Math.abs(degrees) / 5) * 5 - (Math.abs(degrees) % 5 === 0 ? 5 : 0); d >= 5; d -= 5) {
    const to = object.transform.rotation[1] - (Math.sign(degrees) * d * Math.PI) / 180;
    const lead = rotateObject(scene, object, to).operations[0];
    const at = lead.kind === "move" ? lead.to : object.transform.position;
    if (settle(scene, object, at, to)) return d;
  }
  return null;
}

/** An angle brought into (−π, π]. */
const wrap = (a: number) => {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  if (x > Math.PI) x -= 2 * Math.PI;
  return x;
};

// ---------------------------------------------------------------------------
// Size

function planScale(scene: Scene, object: SceneObject, factor: number): { operations: SceneOperation[]; shifted: string | null; clear: string } | { refused: string } {
  const [sx, sy, sz] = object.transform.scale;
  const to: Vec3 = [round(sx * factor, 0.001), round(sy * factor, 0.001), round(sz * factor, 0.001)];
  const [lo, hi] = SCALE_LIMITS.total;
  if (to.some((s) => s < lo || s > hi)) {
    return { refused: `That would make the ${object.label.toLowerCase()} ${to[0] > 1 ? "more than four times" : "less than a quarter of"} the size it was found at, which this editor doesn’t allow.` };
  }
  const [w, h, d] = object.dimensions;
  if (h * to[1] > scene.room.height - (object.support.kind === "wall" ? object.transform.position[1] : 0)) {
    return { refused: `A ${metres(h * to[1])}-tall ${object.label.toLowerCase()} wouldn’t fit under this ${metres(scene.room.height)} ceiling.` };
  }
  const scaled: SceneObject = { ...object, transform: { ...object.transform, scale: to } };
  const scaleOp: SceneOperation = { kind: "scale", objectId: object.id, to };
  const after = applyOperation(scene, scaleOp);
  // Growing from its base centre can push a piece into its wall; keep it inside, as a drag would,
  // and off its neighbours, by the least shift that clears them.
  const lead = moveObject(after, scaled, object.transform.position).operations[0];
  const contained = lead.kind === "move" ? lead.to : object.transform.position;
  const why = refusal(after, scaled, footprintOf(scaled, contained));
  const settled = settle(after, scaled, contained, object.transform.rotation[1], to);
  if (!settled) return { refused: `At ${Math.round(factor * 100)}% the ${object.label.toLowerCase()} (${metres(w * to[0])} × ${metres(d * to[2])}) would run into ${why ?? "the wall"}, and there’s no free spot for it within 40 cm.` };
  const shift = Math.hypot(settled.at[0] - object.transform.position[0], settled.at[2] - object.transform.position[2]);
  const operations: SceneOperation[] = [scaleOp];
  if (shift > 0.001) operations.push(...moveWithLoad(scene, object, settled.at, object.transform.rotation[1]));
  // What the shift keeps it clear of: its wall when it was held inside, and what it would have run into.
  const held = Math.hypot(contained[0] - object.transform.position[0], contained[2] - object.transform.position[2]) > 0.001;
  const clear = [...new Set([held ? "the wall" : null, settled.shift ? why : null].filter((x): x is string => !!x))].join(" and ") || "the wall";
  return { operations, shifted: shift > 0.001 ? `${Math.round(shift * 100)} cm` : null, clear };
}

// ---------------------------------------------------------------------------
// Materials

function planSlot(object: SceneObject, slot: string, base: Material, change: FinishChange): ProposedChange[] {
  if (change.kind === "tone") return restyled(object, slot, base, { color: shift(base.color, change.tone, change.degree) }, `${slot} ${describeTone(change.tone)}`);
  if (change.kind === "colour") return restyled(object, slot, base, { color: change.hex }, `${slot} in ${change.name}`);
  if (base.class === change.material) return [];
  return restyled(object, slot, base, classFinish(base, change.material), `${slot} in ${change.word}`);
}

/** A finish of another class keeps its colour; roughness, metalness and pattern become that class's typical ones. */
function classFinish(base: Material, cls: MaterialClass): Partial<Material> {
  const d = CLASS_DEFAULTS[cls];
  return {
    class: cls,
    roughness: d.roughness[1],
    metalness: d.metalness,
    pattern: d.pattern,
    patternScale: d.patternScale,
    opacity: cls === "glass" ? 0.4 : undefined,
    name: `${d.word}, ${colourName(base.color)}`,
  };
}

function restyled(object: SceneObject, slot: string, base: Material, edit: Partial<Material>, detail: string): ProposedChange[] {
  if (edit.color && edit.color.toLowerCase() === base.color.toLowerCase() && Object.keys(edit).length === 1) return [];
  const to = { ...adjust(base, object.id, slot, edit) };
  if (edit.name) to.name = `${edit.name} (edited)`;
  return [{ id: `material-${object.id}`, group: "Materials", target: object.label, detail, operations: [{ kind: "restyle", objectId: object.id, slot, to }] }];
}

function resurfaced(scene: Scene, surfaces: readonly Surface[], label: string, edit: (m: Material) => Partial<Material>, detail: string): ProposedChange[] {
  const operations = surfaces
    .map((surface): SceneOperation | null => {
      const base = findById(scene.materials, surface.materialId);
      if (!base) return null;
      const e = edit(base);
      if (Object.keys(e).length === 0 || (e.color && Object.keys(e).length === 1 && e.color.toLowerCase() === base.color.toLowerCase())) return null;
      const to = { ...adjust(base, surface.id, "surface", e) };
      if (e.name) to.name = `${e.name} (edited)`;
      return { kind: "resurface", surfaceId: surface.id, to };
    })
    .filter((op): op is SceneOperation => op !== null);
  return operations.length ? [{ id: "surface", group: "Surfaces", target: label, detail, operations }] : [];
}

// ---------------------------------------------------------------------------
// Light

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

  const lamps = lampsWithFixtures(scene);
  const relit = lamps
    .map((lamp): SceneOperation | null => {
      const to = clamp(lamp.colorTemperature - direction * KELVIN_STEP, 1800, 6500);
      return to === lamp.colorTemperature ? null : { kind: "relight", lightId: lamp.id, to: { colorTemperature: to } };
    })
    .filter((op): op is SceneOperation => op !== null);
  if (relit.length > 0) {
    changes.push({ id: "bulbs", group: "Lighting", target: lamps.length > 1 ? "Lamps" : lamps[0].label, detail: direction > 0 ? "warmer bulbs" : "cooler bulbs", operations: relit });
  }
  if (lightingOnly) return changes;

  const tint: Hex = direction > 0 ? "#e8d6b8" : "#d5dee6";
  const painted = walls(scene)
    .map((wall): SceneOperation | null => {
      const base = findById(scene.materials, wall.materialId);
      if (!base) return null;
      const color = mixHex(base.color, tint, TONE.normal.mix);
      if (color === base.color) return null;
      return { kind: "resurface", surfaceId: wall.id, to: adjust(base, wall.id, "surface", { color }) };
    })
    .filter((op): op is SceneOperation => op !== null);
  if (painted.length > 0) {
    changes.push({ id: "walls", group: "Surfaces", target: "Walls", detail: direction > 0 ? "a warmer neutral" : "a cooler neutral", operations: painted });
  }
  return changes;
}

function planRoomBrightness(scene: Scene, direction: 1 | -1): ProposedChange[] {
  const changes: ProposedChange[] = [];
  const daylight = scene.lights.find((l) => l.kind === "daylight");
  if (daylight) {
    // The hour runs midday → night, so more light means an earlier hour.
    const to = clamp01(timeOfDay(scene) - direction * DAYLIGHT_STEP);
    if (to !== timeOfDay(scene)) {
      changes.push({ id: "hour", group: "Lighting", target: "Daylight", detail: direction > 0 ? "a higher sun" : "a later hour", operations: [{ kind: "relight", lightId: daylight.id, to: { timeOfDay: to } }] });
    }
  }
  const lamps = lampsWithFixtures(scene);
  const output = lamps.map((lamp) => lampOutput(lamp, direction)).filter((op): op is SceneOperation => op !== null);
  if (output.length > 0) {
    changes.push({ id: "output", group: "Lighting", target: lamps.length > 1 ? "Lamps" : lamps[0].label, detail: direction > 0 ? "turned up" : "turned down", operations: output });
  }
  return changes;
}

/** More or less daylight: the hour alone, earlier or later. The lamps are left as they are. */
function planDaylight(scene: Scene, direction: 1 | -1): Planned {
  const daylight = scene.lights.find((l) => l.kind === "daylight")!;
  const from = timeOfDay(scene);
  const to = clamp01(from - direction * DAYLIGHT_STEP);
  if (to === from) return { already: direction > 0 ? "The daylight is already at its fullest: the room is set to midday." : "The daylight is already at its lowest: the room is set to night." };
  return {
    summary: direction > 0 ? "More daylight: an earlier, higher sun." : "Less daylight: a later, lower sun.",
    changes: [{ id: "daylight", group: "Lighting", target: "Daylight", detail: `${direction > 0 ? "more" : "less"} daylight, ${hourName(from)} → ${hourName(to)}`, operations: [{ kind: "relight", lightId: daylight.id, to: { timeOfDay: to } }] }],
  };
}

function lampOutput(lamp: ArtificialLight, direction: 1 | -1): SceneOperation | null {
  const from = lamp.intensity ?? 1;
  const to = round(clamp(direction > 0 ? from * OUTPUT_STEP : from / OUTPUT_STEP, 0, 3), 0.01);
  return to === from ? null : { kind: "relight", lightId: lamp.id, to: { intensity: to } };
}

function planLampOutput(lamp: ArtificialLight, label: string, direction: 1 | -1): ProposedChange[] {
  const operation = lampOutput(lamp, direction);
  return operation ? [{ id: `output-${lamp.id}`, group: "Lighting", target: label, detail: direction > 0 ? "turned up" : "turned down", operations: [operation] }] : [];
}

function planLampWarmth(lamp: ArtificialLight, label: string, direction: 1 | -1): ProposedChange[] {
  const to = clamp(lamp.colorTemperature - direction * KELVIN_STEP, 1800, 6500);
  if (to === lamp.colorTemperature) return [];
  return [{ id: `bulb-${lamp.id}`, group: "Lighting", target: label, detail: `${direction > 0 ? "warmer" : "cooler"} bulb, ${to} K`, operations: [{ kind: "relight", lightId: lamp.id, to: { colorTemperature: to } }] }];
}

const lampsWithFixtures = (scene: Scene) => scene.lights.filter((l): l is ArtificialLight => l.kind === "artificial" && scene.objects.some((o) => o.id === l.fixtureId));

// ---------------------------------------------------------------------------
// Reset

function planReset({ scene, original }: CompileContext): ProposedChange[] {
  const placement: SceneOperation[] = [];
  const finishes: SceneOperation[] = [];
  const light: SceneOperation[] = [];

  original.objects.forEach((was, index) => {
    const now = findById(scene.objects, was.id);
    if (!now) {
      const lights = original.lights.flatMap((light, at) => (light.kind === "artificial" && light.fixtureId === was.id ? [{ light, index: at }] : []));
      const relationships = original.relationships.flatMap((relationship, at) => (relationship.subjectId === was.id || relationship.objectId === was.id ? [{ relationship, index: at }] : []));
      placement.push({ kind: "add", object: was, index, relationships, lights });
      return;
    }
    // A piece given a different form goes back to the one it had.
    if (now.form !== was.form || now.category !== was.category) placement.push({ kind: "replace", objectId: was.id, replacement: was });
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
      // An hour the room opened without is unset again, not written down as some hour.
      light.push({ kind: "relight", lightId: was.id, to: { timeOfDay: was.timeOfDay ?? "auto" } });
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

const describeTone = (tone: "darker" | "lighter" | "warmer" | "cooler") =>
  tone === "warmer" ? "warmed" : tone === "cooler" ? "cooled" : tone === "lighter" ? "lightened" : "darkened";

const describeChange = (change: FinishChange) => (change.kind === "tone" ? change.tone : change.kind === "colour" ? change.name : change.word);

function shift(color: Hex, tone: "darker" | "lighter" | "warmer" | "cooler", degree: Degree): Hex {
  const step = TONE[degree];
  if (tone === "warmer") return mixHex(color, "#e8b878", step.mix);
  if (tone === "cooler") return mixHex(color, "#9fb6c8", step.mix);
  return scaleHex(color, tone === "lighter" ? step.lighter : step.darker);
}

const listed = (labels: readonly string[]) => (labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`);

/** A reason as a sentence: capitalised, with a full stop. */
const sentence = (reason: string) => {
  const s = reason.charAt(0).toUpperCase() + reason.slice(1);
  return /[.?!”]$/.test(s) ? s : `${s}.`;
};

// Colour --------------------------------------------------------------------
// The arithmetic itself is shared with the design engine (`model/colour.ts`),
// so a command and a proposal shift a finish the same way.

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => round(clamp(value, 0, 1), 0.01);
/** Round to a step, without the float noise a bare multiply leaves (0.7000000000000001). */
const round = (value: number, step: number) => {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(value / step) * step).toFixed(decimals));
};
const metres = (m: number) => (m >= 1000 ? `${round(m / 1000, 0.1)} km` : m >= 10 ? `${Math.round(m)} m` : `${round(m, 0.01).toFixed(2)} m`);

const warmthSummary = (direction: 1 | -1, lightingOnly: boolean) =>
  lightingOnly
    ? direction > 0
      ? "Warmer light: a later sun and warmer bulbs."
      : "Cooler light: a higher sun and cooler bulbs."
    : direction > 0
      ? "A warmer room: later light, warmer bulbs, warmer walls."
      : "A cooler room: higher light, cooler bulbs, cooler walls.";
