import { CLASS_DEFAULTS, colourName } from "@/scene/compile/materials";
import { mixHex } from "@/scene/model/colour";
import { applyOperations, hourName, type SceneOperation } from "@/scene/model/operations";
import { findById } from "@/scene/model/queries";
import type { Hex, Id, Material, Scene } from "@/scene/model/types";
import type { ProposedChange } from "../ai/interpreter";
import { adjust } from "../state/edits";
import { analyseScene, type DesignAnalysis, type SlotFinish } from "./analysis";
import { axesOf, MAX_VARIANTS, type DesignIntent } from "./intent";
import { MESSAGES } from "./messages";
import { distinct, previewOf, type DesignProposal, type RejectedProposal } from "./proposal";
import { resolveScheme, STYLES, STYLE_ORDER, styleFor, type DesignScheme, type DesignStyle } from "./styles";
import { validateOperations } from "./validate";

/**
 * Turning a design intent into proposals.
 * ================================================================
 *
 *   Scene + DesignAnalysis + DesignIntent → DesignProposal[]
 *
 * Deterministic all the way through: the styles are a fixed table, the
 * variants are a fixed table, the room is read in its own order, and every
 * colour is arithmetic on the colour the compiler measured. The same three
 * inputs always give the same proposals, operation for operation.
 *
 * Every proposal is checked against the Scene before it leaves here
 * (`validate.ts`). One that cannot be applied safely is not quietly fixed
 * up and shown anyway: it is left out, with the reason kept.
 */

export interface GenerationResult {
  ok: boolean;
  analysis: DesignAnalysis;
  proposals: readonly DesignProposal[];
  /** Proposals the validator would not pass, with why. Usually empty. */
  rejected: readonly RejectedProposal[];
  /** Set when nothing could be offered. */
  reason?: string;
}

export function generateProposals(scene: Scene, intent: DesignIntent, analysis = analyseScene(scene)): GenerationResult {
  const axes = axesOf(intent);
  const count = Math.min(Math.max(1, Math.round(intent.variantCount)), MAX_VARIANTS);
  const proposals: DesignProposal[] = [];
  const rejected: RejectedProposal[] = [];

  for (const [style, variantIndex] of readings(intent.styles, count, axes)) {
    const preset = STYLES[style];
    const scheme = resolveScheme(preset, preset.variants[variantIndex], axes);
    const planned = plan(scene, analysis, scheme);
    const id = `${kebab(style)}-${scheme.variant.key}`;
    if (planned.operations.length === 0) {
      rejected.push({ id, title: scheme.title, reason: MESSAGES.nothingToChange });
      continue;
    }
    const checked = validateOperations(scene, planned.operations);
    if (!checked.ok) {
      rejected.push({ id, title: scheme.title, reason: checked.reason });
      continue;
    }
    proposals.push({
      id,
      title: scheme.title,
      style,
      variant: scheme.variant.key,
      description: scheme.variant.note,
      designGoals: scheme.goals,
      operations: planned.operations,
      affectedObjects: distinct(planned.operations.flatMap((op) => (op.kind === "restyle" ? [op.objectId] : []))),
      affectedMaterials: distinct(planned.operations.flatMap((op) => (op.kind === "restyle" || op.kind === "resurface" ? [op.to.id] : []))),
      affectedLighting: distinct(planned.operations.flatMap((op) => (op.kind === "relight" ? [op.lightId] : []))),
      rationale: planned.rationale,
      constraints: planned.constraints,
      changes: planned.changes,
      preview: previewOf(planned.operations),
      status: "draft",
    });
  }

  return {
    ok: proposals.length > 0,
    analysis,
    proposals,
    rejected,
    ...(proposals.length === 0 && { reason: rejected[0]?.reason ?? MESSAGES.nothingToChange }),
  };
}

/**
 * Which style, and which of its readings, each proposal is.
 *
 * One style named gives that style's variants in order; several named give
 * one reading of each before a second of any; none named picks the style
 * the request's axes point at, or — when the request says nothing at all —
 * a spread across the vocabulary, so "three designs" are three directions
 * rather than three shades of one.
 */
function readings(styles: readonly DesignStyle[], count: number, axes: ReturnType<typeof axesOf>): [DesignStyle, number][] {
  const asked = styles.length > 0 ? styles : chosen(axes, count);
  const pairs: [DesignStyle, number][] = [];
  for (let variant = 0; variant < MAX_VARIANTS && pairs.length < count; variant++) {
    for (const style of asked) {
      if (pairs.length === count) break;
      pairs.push([style, variant]);
    }
  }
  return pairs;
}

/** With no style named: the one the axes point at, then the rest in their listed order. */
function chosen(axes: ReturnType<typeof axesOf>, count: number): DesignStyle[] {
  const first = styleFor(axes);
  if (count === 1) return [first];
  return [first, ...STYLE_ORDER.filter((s) => s !== first)].slice(0, count);
}

// ---------------------------------------------------------------------------
// The plan for one scheme

interface Planned {
  operations: readonly SceneOperation[];
  changes: readonly ProposedChange[];
  rationale: readonly string[];
  constraints: readonly string[];
}

/**
 * What a scheme means for this room.
 *
 * Read in the Scene's own order — surfaces, then object finishes, then
 * light — so the plan is stable. An operation that would change nothing is
 * dropped rather than counted, by applying it: a proposal never offers a
 * change the room already has.
 */
function plan(scene: Scene, analysis: DesignAnalysis, scheme: DesignScheme): Planned {
  const changes: ProposedChange[] = [];
  const rationale: string[] = [];
  const constraints = [...scheme.constraints, MESSAGES.finishesOnly];
  let working = scene;

  /** Keep an operation only if it genuinely changes the room. */
  const keep = (operations: readonly SceneOperation[]): SceneOperation[] => {
    const kept: SceneOperation[] = [];
    for (const operation of operations) {
      const next = applyOperations(working, [operation]);
      if (next === working) continue;
      working = next;
      kept.push(operation);
    }
    return kept;
  };

  // Surfaces ----------------------------------------------------------------
  const walls = keep(
    analysis.materials.walls.map((wall) => resurface(scene, wall.surfaceId, wall.materialId, scheme.palette.wall)).filter(isOperation),
  );
  if (walls.length) {
    changes.push({ id: "walls", group: "Surfaces", target: "Walls", detail: `repainted ${colourName(scheme.palette.wall)}`, operations: walls });
    rationale.push(`The ${walls.length === 1 ? "wall is" : `${walls.length} walls are`} the largest surface the room has, so the palette is carried there first: ${colourName(scheme.palette.wall)}.`);
  }

  const ceiling = analysis.materials.ceiling;
  if (ceiling) {
    const operations = keep([resurface(scene, ceiling.surfaceId, ceiling.materialId, scheme.palette.ceiling)].filter(isOperation));
    if (operations.length) {
      changes.push({ id: "ceiling", group: "Surfaces", target: "Ceiling", detail: `${colourName(scheme.palette.ceiling)}`, operations });
    }
  }

  const floor = analysis.materials.floor;
  if (floor) {
    if (scheme.floor.keep.includes(floor.class)) {
      constraints.push(`The ${floor.class} floor the photograph measured is kept`);
      rationale.push(`The floor is ${floor.class}, which this style keeps: it is the one finish in the room that was read from a reflection, not a prior.`);
    } else {
      // The style's own floor tone. What the photograph measured about the
      // floor that is not its colour — its pattern, its tile size, how much
      // it reflects — is carried through untouched.
      const color = scheme.floor.colour;
      const operations = keep([resurface(scene, floor.surfaceId, floor.materialId, color)].filter(isOperation));
      if (operations.length) {
        changes.push({ id: "floor", group: "Surfaces", target: "Floor", detail: `${colourName(color)}`, operations });
        rationale.push(`The ${floor.class} floor takes the style's own tone, ${colourName(color)}; its pattern and gloss, which were measured from the photograph, are kept.`);
      }
    }
  }

  // Object finishes ---------------------------------------------------------
  let accentsLeft = accentBudget(analysis, scheme);
  const finishes: SceneOperation[] = [];
  const touched: string[] = [];
  let unestimated = 0;

  for (const slot of analysis.materials.slots) {
    const family = familyOf(slot);
    if (!family) continue;
    if (family === "accent") {
      if (accentsLeft <= 0) continue;
      accentsLeft -= 1;
    }
    const base = findById(scene.materials, slot.materialId);
    if (!base || base.class === "glass") continue;
    const color = colourFor(family, base, scheme);
    const operations = keep([restyle(slot, base, color)].filter(isOperation));
    if (operations.length === 0) continue;
    finishes.push(...operations);
    touched.push(slot.label);
    if (slot.unestimated) unestimated += 1;
  }

  if (finishes.length) {
    const names = distinct(touched);
    changes.push({
      id: "finishes",
      group: "Materials",
      target: names.length > 2 ? `${names.length} pieces` : names.join(" and "),
      detail: `recoloured to the ${scheme.title.toLowerCase()} palette`,
      operations: finishes,
    });
    rationale.push(`${finishes.length} finishes take the palette: seating and textiles at its lighter end, timber at its darker one, which is where this style puts its contrast.`);
    if (unestimated > 0) {
      constraints.push(`${unestimated} of the finishes changed were stand-ins the photograph never showed on their own`);
    }
  }

  // Light -------------------------------------------------------------------
  const light: SceneOperation[] = [];
  const daylight = analysis.lighting.daylight;
  if (daylight) {
    const from = analysis.lighting.hour;
    const to = scheme.light.timeOfDay;
    const operations = keep([{ kind: "relight", lightId: daylight.id, to: { timeOfDay: to } } as SceneOperation]);
    if (operations.length) {
      light.push(...operations);
      // Both hours can fall in the same part of the day; saying "early
      // afternoon → early afternoon" would read as no change at all.
      const detail = hourName(from) === hourName(to) ? `${to > from ? "later" : "earlier"} ${hourName(to)}` : `${hourName(from)} → ${hourName(to)}`;
      changes.push({ id: "daylight", group: "Lighting", target: "Daylight", detail, operations });
      rationale.push(`The room's daylight is set to ${hourName(scheme.light.timeOfDay)}; the hour is not recoverable from a photograph, so it is the style's choice, not a measurement.`);
    }
  }

  for (const lamp of analysis.lighting.lamps) {
    const wanted = {
      colorTemperature: scheme.light.kelvin,
      intensity: scheme.light.output,
      ...(scheme.light.lampsOn && lamp.on !== true && { on: true as const }),
    };
    const operations = keep([{ kind: "relight", lightId: lamp.id, to: wanted } as SceneOperation]);
    if (operations.length === 0) continue;
    light.push(...operations);
    const switched = scheme.light.lampsOn && lamp.on !== true;
    changes.push({
      id: `lamp-${lamp.id}`,
      group: "Lighting",
      target: lamp.label,
      detail: `${scheme.light.kelvin} K${switched ? ", switched on" : ""}`,
      operations,
    });
    if (switched) rationale.push(`The ${lamp.label.toLowerCase()} was found unlit in the photograph; at this hour the style has it on.`);
  }

  return { operations: [...changes.flatMap((change) => change.operations)], changes, rationale, constraints: distinct(constraints) };
}

// ---------------------------------------------------------------------------
// What each finish becomes

/** The families of finish a style has an opinion about. */
type Family = "upholstery" | "textile" | "timber" | "shade" | "accent";

const UPHOLSTERY = new Set(["upholstery", "cover", "seat", "bedding", "cushion"]);
const TEXTILE = new Set(["fabric", "pile", "weave"]);
const TIMBER = new Set(["frame", "body", "top", "stand", "base", "leg", "legs", "shelf"]);

/**
 * Which family a finish belongs to, or none — in which case it is left
 * alone. A television's screen, a plant's leaves and a window's glass are
 * not a palette's business, and a slot this engine does not recognise is
 * not guessed at.
 */
function familyOf(slot: SlotFinish): Family | null {
  if (slot.category === "television" || slot.category === "plant") return null;
  if (slot.category === "artwork") return slot.slot === "surface" ? "accent" : "timber";
  if (slot.category === "curtain" || slot.category === "rug") return "textile";
  if (slot.slot === "shade") return "shade";
  if (UPHOLSTERY.has(slot.slot)) return "upholstery";
  if (TEXTILE.has(slot.slot)) return "textile";
  if (TIMBER.has(slot.slot)) return "timber";
  return null;
}

/**
 * What a finish becomes. A metal or stone piece keeps its own character —
 * the palette's metal tone, or a light touch on stone — because repainting
 * a measured material as if it were timber would be a claim the photograph
 * never made.
 */
function colourFor(family: Family, base: Material, scheme: DesignScheme): Hex {
  if (base.class === "metal") return scheme.palette.metal;
  switch (family) {
    case "upholstery":
      return scheme.palette.upholstery;
    case "textile":
      return scheme.palette.textile;
    case "shade":
      return scheme.palette.shade;
    case "accent":
      return scheme.palette.accent;
    case "timber":
      return base.class === "stone" || base.class === "ceramic"
        ? mixHex(base.color, scheme.palette.wood, 0.4)
        : scheme.palette.wood;
  }
}

/**
 * How many pieces may carry the accent colour. Restraint is the point: at
 * full strength every piece that can take one does, and at the minimal end
 * none does.
 */
function accentBudget(analysis: DesignAnalysis, scheme: DesignScheme): number {
  const candidates = analysis.materials.slots.filter((slot) => familyOf(slot) === "accent").length;
  if (scheme.accent <= 0.1) return 0;
  if (scheme.accent >= 0.75) return candidates;
  return Math.max(1, Math.round(candidates * scheme.accent));
}

// ---------------------------------------------------------------------------
// Operations

/**
 * Finishes are forked per surface and per slot through the same helper the
 * panels and the command layer use, so a proposal's materials are ordinary
 * edited materials and undo puts the library back exactly as it was.
 */
function resurface(scene: Scene, surfaceId: Id, materialId: Id, color: Hex): SceneOperation | null {
  const base = findById(scene.materials, materialId);
  if (!base) return null;
  return { kind: "resurface", surfaceId, to: named(adjust(base, surfaceId, "surface", { color })) };
}

function restyle(slot: SlotFinish, base: Material, color: Hex): SceneOperation | null {
  return { kind: "restyle", objectId: slot.objectId, slot: slot.slot, to: named(adjust(base, slot.objectId, slot.slot, { color })) };
}

/** A finish named for what it is, not for the style that chose it. */
const named = (material: Material): Material => ({ ...material, name: `${CLASS_DEFAULTS[material.class].word}, ${colourName(material.color)}` });

const isOperation = (op: SceneOperation | null): op is SceneOperation => op !== null;

const kebab = (style: DesignStyle) => style.toLowerCase().replace(/_/g, "-");
