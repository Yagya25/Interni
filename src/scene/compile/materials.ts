import type { Hex, Id, Material, MaterialClass, ObjectCategory, SurfacePattern, WallSurface } from "@/scene/model/types";
import type { EntityEvidence } from "./evidence";
import { DEG, round } from "./frame";
import type { AppearanceObservation, Basis, ColourStats, InstanceObservation, Quantity, ReconstructionIntermediate } from "./intermediate";
import type { CategoryPrior } from "./vocabulary";

/**
 * Materials from the photograph
 * =============================
 * Every material a reconstructed Scene carries is one region of the
 * photograph (a fitted floor, wall or ceiling; a segmented piece; a part of
 * one), read three ways, and each field says how it is known:
 *
 * - class: SigLIP 2's zero-shot logits over the Scene's own classes,
 *   restricted to what this surface or slot can be made of (a sofa is fabric
 *   or leather, never paper). `estimated` when the best allowed class beats
 *   the next by the margin; the slot's typical class, `default`, when it
 *   does not; `inferred` when only one class is possible (a curtain);
 * - colour: the region's apparent colour, the median of its well-exposed
 *   pixels, `estimated`. It is the surface under this photo's light: the
 *   light is not divided out, because one photograph cannot separate them,
 *   so the Scene's light is kept neutral instead (see `lighting.ts`) and the
 *   photo's warmth is carried once, by the surfaces;
 * - roughness: measured only where the photograph shows it — a floor that
 *   mirrors the room's opening is glossy, and how sharp the mirror image is
 *   says how glossy. Everywhere else it is the class's typical value,
 *   `inferred`, with the range in the note. Metalness is always the class's;
 * - pattern: tiles on a ceramic floor, planks on a wooden one, grain and
 *   weave on wooden and fabric pieces, all `inferred` from the class; a tile
 *   size only when the rectified floor shows the same period along both axes.
 *
 * Walls of one paint look different where the light differs, not where the
 * paint does: walls whose chromaticity agrees are one material, coloured by
 * the best-lit of them. Names describe and claim nothing more
 * ("Painted surface, light beige"), never a species or a brand.
 */

export const MATERIAL_RULES = {
  version: "material-rules-0.1",
  /** SigLIP 2 logit margin, best allowed class over the next, below which the class is the slot's typical one. */
  classMargin: 0.5,
  /** Walls within this CIE u'v' distance of each other, and of one class, are one paint. */
  samePaintUV: 0.012,
  /** Fewer well-exposed pixels than this and a region's colour is not read. */
  minWellExposed: 100,
  gloss: {
    /** Mirrored region at least this much brighter than the floor beside it: a glossy floor. */
    glossyContrast: 1.25,
    /** Below this, no mirror image is seen at all. */
    noReflection: 1.1,
    /** Roughness by how much the mirror image is blurred (degrees of arc): [up to, roughness]. */
    roughnessByBlurDeg: [
      [0.15, 0.08],
      [0.5, 0.18],
      [Infinity, 0.3],
    ] as const,
  },
  tiles: {
    /** Both axes' periods within this share of each other. */
    agree: 0.1,
    /** Autocorrelation at the period, on each axis. */
    strength: 0.2,
    /** The tile texture draws 4 × 4 tiles per repeat. */
    perRepeat: 4,
    /** A common floor tile, used when the photograph does not measure one. */
    defaultSize: 0.6,
  },
} as const;

type Range = readonly [p10: number, p50: number, p90: number];

/** What a class is typically like, where the photograph cannot say. */
export const CLASS_DEFAULTS: Readonly<Record<MaterialClass, { word: string; roughness: Range; metalness: number; pattern: SurfacePattern; patternScale?: number }>> = {
  wood: { word: "Wood", roughness: [0.35, 0.5, 0.7], metalness: 0, pattern: "grain", patternScale: 0.8 },
  fabric: { word: "Fabric", roughness: [0.8, 0.95, 1], metalness: 0, pattern: "weave", patternScale: 0.35 },
  stone: { word: "Stone", roughness: [0.2, 0.4, 0.7], metalness: 0, pattern: "none" },
  glass: { word: "Glass", roughness: [0.02, 0.05, 0.1], metalness: 0, pattern: "none" },
  metal: { word: "Metal", roughness: [0.2, 0.35, 0.6], metalness: 0.9, pattern: "none" },
  paint: { word: "Painted surface", roughness: [0.8, 0.9, 0.95], metalness: 0, pattern: "none" },
  ceramic: { word: "Ceramic", roughness: [0.05, 0.25, 0.5], metalness: 0, pattern: "none" },
  paper: { word: "Paper", roughness: [0.85, 0.9, 0.95], metalness: 0, pattern: "none" },
  leather: { word: "Leather", roughness: [0.4, 0.55, 0.7], metalness: 0, pattern: "none" },
  plant: { word: "Foliage", roughness: [0.6, 0.7, 0.8], metalness: 0, pattern: "none" },
};

/** On the room's own surfaces the class implies a laid pattern. */
const SURFACE_PATTERN: Partial<Record<MaterialClass, { pattern: SurfacePattern; patternScale: number }>> = {
  ceramic: { pattern: "tiles", patternScale: MATERIAL_RULES.tiles.defaultSize * MATERIAL_RULES.tiles.perRepeat },
  wood: { pattern: "planks", patternScale: 2.4 },
};

/**
 * What each surface and slot may be made of, typical class first. A single
 * entry means the category settles it and nothing is classified.
 */
export const ALLOWED_CLASSES: Readonly<Record<string, readonly MaterialClass[]>> = {
  "surface.floor": ["wood", "ceramic", "stone", "fabric"],
  "surface.wall": ["paint", "paper", "wood", "stone", "ceramic"],
  "surface.ceiling": ["paint", "wood"],
  "opening.frame": ["paint", "metal", "wood"],
  "opening.glazing": ["glass"],
  "opening.leaf": ["paint", "wood", "metal", "glass"],
  "sofa.upholstery": ["fabric", "leather"],
  "armchair.upholstery": ["fabric", "leather"],
  "lounge-chair.upholstery": ["fabric", "leather"],
  "ottoman.cover": ["fabric", "leather"],
  "bench.top": ["wood", "fabric", "leather", "metal", "stone"],
  "chair.frame": ["wood", "metal"],
  "coffee-table.top": ["wood", "glass", "stone", "metal"],
  "side-table.top": ["wood", "glass", "stone", "metal"],
  "dining-table.top": ["wood", "glass", "stone", "metal"],
  "desk.top": ["wood", "glass", "metal"],
  "cabinet.body": ["wood", "metal", "glass"],
  "sideboard.body": ["wood", "metal", "glass", "stone"],
  "media-console.body": ["wood", "metal", "glass", "stone"],
  "bookshelf.body": ["wood", "metal", "glass"],
  "bed.bedding": ["fabric"],
  "television.screen": ["glass"],
  "plant.foliage": ["plant"],
  "floor-lamp.shade": ["fabric", "paper", "glass", "metal"],
  "floor-lamp.stand": ["wood", "metal"],
  "curtain.fabric": ["fabric"],
  "artwork.surface": ["paper", "fabric"],
  "artwork.frame": ["wood", "metal"],
  "rug.pile": ["fabric"],
};

/**
 * Which part of a piece's region a slot is read from. Slots not listed here
 * (a sofa's legs, a TV's bezel) were not seen apart from the whole and stay
 * the neutral stand-in, said to be so.
 */
const SLOT_REGION: Readonly<Record<string, "whole" | "same-as-primary" | string>> = {
  "floor-lamp.shade": "upper",
  "floor-lamp.stand": "lower",
  "artwork.surface": "surface",
  "artwork.frame": "frame",
  // The mask covers the whole table or console, legs included, and shows one finish.
  "coffee-table.legs": "same-as-primary",
  "side-table.legs": "same-as-primary",
  "dining-table.legs": "same-as-primary",
  "desk.legs": "same-as-primary",
  "media-console.legs": "same-as-primary",
};

/** Stand-ins for an opening's parts the photograph does not show on their own. */
const OPENING_STAND_INS: readonly Material[] = [
  { id: "unestimated-frame", class: "paint", name: "Frame — finish not estimated", color: "#d9d5ce", roughness: 0.6, metalness: 0, pattern: "none" },
  { id: "unestimated-glazing", class: "glass", name: "Glazing (assumed clear)", color: "#c9d6db", roughness: 0.05, metalness: 0, pattern: "none", opacity: 0.25 },
  { id: "unestimated-door", class: "paint", name: "Door leaf — finish not estimated", color: "#cfc9c0", roughness: 0.7, metalness: 0, pattern: "none" },
];

export interface MaterialsReport {
  rulesVersion: string;
  promptsVersion: string | null;
  assigned: readonly { materialId: Id; target: string; region: string | null; class: MaterialClass; classBasis: Basis; margin: number | null; roughnessBasis: Basis }[];
  /** Surfaces or pieces that share one finish seen under different light. */
  shared: readonly { materialId: Id; members: readonly Id[]; note: string }[];
  notEstimated: readonly { target: string; reason: string }[];
}

type Gloss = { glossy: true; roughness: number; note: string } | { glossy: false; note: string };

interface Resolved {
  cls: MaterialClass;
  basis: Basis;
  margin: number | null;
  note: string;
  alternatives: { field: string; value: string; score: number }[];
}

/**
 * The materials of one compile: built as the shell, the objects and the
 * openings ask for them, and read out once at the end. Insertion order is
 * the callers' order, which is itself deterministic.
 */
export class MaterialBook {
  readonly observed: boolean;
  private readonly regions = new Map<string, AppearanceObservation>();
  private readonly list: Material[] = [];
  private readonly evidence: Record<Id, EntityEvidence> = {};
  private readonly assigned: MaterialsReport["assigned"][number][] = [];
  private readonly merged: MaterialsReport["shared"][number][] = [];
  private readonly missing: MaterialsReport["notEstimated"][number][] = [];
  private readonly promptsVersion: string | null;
  private readonly standIns = new Set<Id>();
  private accent = false;

  constructor(private readonly input: ReconstructionIntermediate, private readonly sources: { material: string; segmentation: string }) {
    for (const a of input.world.appearance ?? []) this.regions.set(a.regionId, a);
    this.observed = this.regions.size > 0;
    this.promptsVersion = [...this.regions.values()].find((a) => a.materialClass)?.materialClass?.promptsVersion ?? null;
  }

  region(id: string) {
    return this.regions.get(id);
  }

  // Surfaces ---------------------------------------------------------------------

  /** A floor or ceiling plane's material id, or null when the photograph gives nothing to read. */
  plane(role: "floor" | "ceiling", planeId: string | null, openingInstances: readonly string[]): Id | null {
    const obs = planeId ? this.regions.get(planeId) : undefined;
    if (!obs) {
      if (this.observed) this.missing.push({ target: role, reason: planeId ? "too few pixels of it were seen" : "it was not seen" });
      return null;
    }
    const key = `surface.${role}`;
    const resolved = this.resolve(key, obs, ALLOWED_CLASSES[key][0], role);
    const colour = role === "floor" ? (obs.colourOutsideReflections ?? obs.colour) : obs.colour;
    if (colour.wellExposedPixels < MATERIAL_RULES.minWellExposed) {
      this.missing.push({ target: role, reason: "too few of its pixels are well exposed to read a colour" });
      return null;
    }
    const gloss = role === "floor" ? this.gloss(obs, openingInstances) : null;
    const pattern = this.surfacePattern(resolved.cls, obs);
    const id = `m-${role}`;
    this.add(id, role, obs.regionId, resolved, colour, { gloss, pattern, colourNote: role === "floor" && obs.colourOutsideReflections ? "median of its well-exposed pixels outside the mirror images of the room's openings" : undefined });
    return id;
  }

  /**
   * One material per paint: walls whose class and chromaticity agree share
   * one, coloured by the best-lit of them. Returns wall id → material id for
   * the walls that were seen; unseen walls take the paint of the largest group.
   */
  walls(walls: readonly WallSurface[], planeOfWall: Readonly<Record<Id, string | null>>): Record<Id, Id> {
    type Seen = { wall: WallSurface; obs: AppearanceObservation };
    const seen: Seen[] = [];
    for (const wall of walls) {
      const planeId = planeOfWall[wall.id];
      const obs = planeId ? this.regions.get(planeId) : undefined;
      if (!obs || obs.colour.wellExposedPixels < MATERIAL_RULES.minWellExposed) continue;
      seen.push({ wall, obs });
    }
    // One paint looks different where the light differs: group by chromaticity, then read the
    // group's class from all of its walls at once.
    const groups: Seen[][] = [];
    for (const s of seen) {
      const home = groups.find((g) => g.every((o) => uvDistance(o.obs.colour.linear, s.obs.colour.linear) <= MATERIAL_RULES.samePaintUV));
      if (home) home.push(s);
      else groups.push([s]);
    }
    const out: Record<Id, Id> = {};
    groups.forEach((group, i) => {
      const lit = group.reduce((a, b) => (b.obs.colour.luminance > a.obs.colour.luminance ? b : a));
      const id = groups.length === 1 ? "m-wall" : `m-wall-${i}`;
      const names = group.map((g) => g.wall.label.toLowerCase());
      const scored = { ...lit.obs, materialClass: meanScores(group.map((g) => g.obs)) };
      const resolved = this.resolve("surface.wall", scored, "paint", group.length > 1 ? "wall" : names[0]);
      const others = group.filter((g) => g !== lit).map((g) => g.wall.label.toLowerCase());
      this.add(id, group.map((g) => g.wall.id).join("+"), lit.obs.regionId, resolved, lit.obs.colour, {
        gloss: null,
        pattern: this.surfacePattern(resolved.cls, lit.obs),
        colourNote: others.length ? `the ${lit.wall.label.toLowerCase()}'s, the best lit of the walls of this paint` : undefined,
      });
      if (group.length > 1) {
        const e = this.evidence[id];
        this.evidence[id] = { ...e, observations: group.map((g) => g.obs.regionId), notes: [...e.notes, `Its class is read from all ${group.length} walls' scores together.`] };
        this.merged.push({
          materialId: id,
          members: group.map((g) => g.wall.id),
          note: `Chromaticity within u'v' ${MATERIAL_RULES.samePaintUV}: one paint, seen under different light on the ${[lit.wall.label.toLowerCase(), ...others].join(", ")}.`,
        });
      }
      for (const g of group) out[g.wall.id] = id;
    });
    const largest = groups.reduce<Seen[] | null>((a, b) => (!a || b.length > a.length ? b : a), null);
    for (const wall of walls) {
      if (out[wall.id]) continue;
      if (largest && out[largest[0].wall.id]) {
        out[wall.id] = out[largest[0].wall.id];
        const e = this.evidence[out[wall.id]];
        this.evidence[out[wall.id]] = { ...e, notes: [...e.notes, `The ${wall.label.toLowerCase()} was not seen; it is taken to be the same paint (inferred).`] };
      } else if (this.observed) {
        this.missing.push({ target: wall.id, reason: "not seen, and no wall was seen to take a paint from" });
      }
    }
    return out;
  }

  // Objects ------------------------------------------------------------------------

  /** Slot → material id for a reconstructed piece. */
  objectSlots(objectId: Id, prior: CategoryPrior, inst: InstanceObservation): Record<string, Id> {
    const slots: Record<string, Id> = {};
    const primaryKey = `${prior.category}.${prior.primarySlot}`;
    const whole = this.regions.get(inst.id);
    if (!this.observed || !whole) {
      slots[prior.primarySlot] = this.legacy(objectId, prior, inst);
    } else {
      const primaryRegion = this.slotRegion(prior.category, prior.primarySlot, inst.id) ?? whole;
      const id = `m-${objectId}`;
      const resolved = this.resolve(primaryKey, primaryRegion, prior.materialClass, `${readable(prior.category).toLowerCase()}'s ${prior.primarySlot}`);
      this.add(id, `${objectId}.${prior.primarySlot}`, primaryRegion.regionId, resolved, primaryRegion.colour, { gloss: null, pattern: objectPattern(resolved.cls) });
      slots[prior.primarySlot] = id;
    }
    for (const slot of prior.secondarySlots) {
      const how = SLOT_REGION[`${prior.category}.${slot}`];
      if (how === "same-as-primary" && this.observed && whole) {
        slots[slot] = slots[prior.primarySlot];
        continue;
      }
      const region = how && how !== "same-as-primary" ? this.regions.get(`${inst.id}:${how}`) : undefined;
      const key = `${prior.category}.${slot}`;
      if (region && ALLOWED_CLASSES[key]) {
        const id = `m-${objectId}-${slot}`;
        const typical = ALLOWED_CLASSES[key][0];
        const resolved = this.resolve(key, region, typical, `${readable(prior.category).toLowerCase()}'s ${slot}`);
        this.add(id, `${objectId}.${slot}`, region.regionId, resolved, region.colour, { gloss: null, pattern: objectPattern(resolved.cls) });
        slots[slot] = id;
      } else {
        slots[slot] = "unestimated-accent";
        this.accent = true;
      }
    }
    return slots;
  }

  /**
   * Pieces that are one finish seen under different light (a pair of
   * curtains at one window) share the best-lit piece's material. Returns the
   * material id each given material should become.
   */
  unify(materialIds: readonly Id[], why: string): Record<Id, Id> {
    const members = materialIds
      .map((id) => ({ id, material: this.list.find((m) => m.id === id), region: this.regions.get(this.evidence[id]?.observations[0] ?? "") }))
      .filter((m): m is { id: Id; material: Material; region: AppearanceObservation } => Boolean(m.material && m.region));
    const out: Record<Id, Id> = {};
    const groups: (typeof members)[] = [];
    for (const m of members) {
      const home = groups.find((g) => g[0].material.class === m.material.class && g.every((o) => uvDistance(o.region.colour.linear, m.region.colour.linear) <= MATERIAL_RULES.samePaintUV));
      if (home) home.push(m);
      else groups.push([m]);
    }
    for (const group of groups) {
      if (group.length < 2) continue;
      const lit = group.reduce((a, b) => (b.region.colour.luminance > a.region.colour.luminance ? b : a));
      for (const m of group) {
        out[m.id] = lit.id;
        if (m === lit) continue;
        this.list.splice(this.list.indexOf(m.material), 1);
        delete this.evidence[m.id];
        const at = this.assigned.findIndex((a) => a.materialId === m.id);
        if (at >= 0) this.assigned.splice(at, 1);
      }
      const e = this.evidence[lit.id];
      this.evidence[lit.id] = {
        ...e,
        observations: group.map((m) => m.region.regionId),
        notes: [...e.notes, `${why}: chromaticity within u'v' ${MATERIAL_RULES.samePaintUV}, so one finish, coloured by the best lit (${lit.region.regionId}).`],
      };
      this.merged.push({ materialId: lit.id, members: group.map((m) => m.id), note: why });
    }
    return out;
  }

  // Openings -----------------------------------------------------------------------

  opening(openingId: Id, inst: InstanceObservation, glazed: boolean): { frameMaterialId: Id; panelMaterialId: Id } {
    const frame = this.regions.get(`${inst.id}:frame`);
    const whole = this.regions.get(inst.id);
    let frameId = "unestimated-frame";
    if (frame) {
      frameId = `m-${openingId}-frame`;
      this.add(frameId, `${openingId}.frame`, frame.regionId, this.resolve("opening.frame", frame, "paint", "opening frame"), frame.colour, { gloss: null, pattern: { pattern: "none", basis: "inferred" } });
    } else {
      this.standIns.add(frameId);
      if (this.observed) this.missing.push({ target: `${openingId}.frame`, reason: "its frame could not be told apart from what is seen through it" });
    }
    if (glazed) {
      this.standIns.add("unestimated-glazing");
      return { frameMaterialId: frameId, panelMaterialId: "unestimated-glazing" };
    }
    if (!whole) {
      this.standIns.add("unestimated-door");
      return { frameMaterialId: frameId, panelMaterialId: "unestimated-door" };
    }
    const leafId = `m-${openingId}-leaf`;
    this.add(leafId, `${openingId}.leaf`, whole.regionId, this.resolve("opening.leaf", whole, "paint", "door leaf"), whole.colour, { gloss: null, pattern: { pattern: "none", basis: "inferred" } });
    return { frameMaterialId: frameId, panelMaterialId: leafId };
  }

  // Output -------------------------------------------------------------------------

  materials(): Material[] {
    const out = [...this.list];
    if (this.accent) out.push({ id: "unestimated-accent", class: "wood", name: "Secondary parts — not estimated", color: "#4a4440", roughness: 0.8, metalness: 0, pattern: "none" });
    for (const m of OPENING_STAND_INS) if (this.standIns.has(m.id)) out.push(m);
    return out;
  }

  entities(): Record<Id, EntityEvidence> {
    const out = { ...this.evidence };
    if (this.accent) out["unestimated-accent"] = { kind: "material", presence: { basis: "default" }, fields: {}, observations: [], notes: ["Legs, frames and other secondary parts not seen apart from the whole: a neutral stand-in."] };
    for (const m of OPENING_STAND_INS) {
      if (!this.standIns.has(m.id)) continue;
      const note = m.id === "unestimated-glazing" && this.observed
        ? "The glass itself is not seen, only what lies beyond it: clear glass is assumed."
        : "Not estimated in this version; a stated stand-in.";
      out[m.id] = { kind: "material", presence: { basis: "default" }, fields: {}, observations: [], notes: [note] };
    }
    return out;
  }

  report(): MaterialsReport {
    return { rulesVersion: MATERIAL_RULES.version, promptsVersion: this.promptsVersion, assigned: this.assigned, shared: this.merged, notEstimated: this.missing };
  }

  // Internals ----------------------------------------------------------------------

  private slotRegion(category: ObjectCategory, slot: string, instanceId: string) {
    const how = SLOT_REGION[`${category}.${slot}`];
    return how && how !== "same-as-primary" && how !== "whole" ? this.regions.get(`${instanceId}:${how}`) : undefined;
  }

  private resolve(key: string, obs: AppearanceObservation, typical: MaterialClass, what: string): Resolved {
    const r = this.pick(key, obs, typical);
    const note = r.note.replace(/\b([Aa]) \{what\}/g, (_, a: string) => `${article(what, a === "A")} ${what}`).replace(/\{what\}/g, what);
    return { ...r, note };
  }

  private pick(key: string, obs: AppearanceObservation, typical: MaterialClass): Resolved {
    const allowed = ALLOWED_CLASSES[key] ?? [typical];
    const fallback = allowed.includes(typical) ? typical : allowed[0];
    if (allowed.length === 1) {
      return { cls: allowed[0], basis: "inferred", margin: null, note: `A {what} is ${allowed[0]}: the category settles it.`, alternatives: [] };
    }
    const scores = obs.materialClass?.scores;
    if (!scores) {
      return { cls: fallback, basis: "default", margin: null, note: `Not classified (too few pixels): ${fallback}, the typical class for a {what}.`, alternatives: [] };
    }
    const ranked = allowed
      .map((c, order) => ({ c, order, logit: scores.find((s) => s.class === c)?.logit ?? -Infinity }))
      .sort((a, b) => b.logit - a.logit || a.order - b.order);
    const margin = round(ranked[0].logit - ranked[1].logit, 0.001);
    const readings = ranked.map((r) => `${r.c} ${r.logit.toFixed(2)}`).join(", ");
    const alternatives = ranked.slice(1).map((r) => ({ field: "class", value: r.c, score: r.logit }));
    if (margin < MATERIAL_RULES.classMargin) {
      return { cls: fallback, basis: "default", margin, note: `SigLIP 2 could not tell ${ranked[0].c} from ${ranked[1].c} (logits ${readings}; margin ${margin} < ${MATERIAL_RULES.classMargin}): ${fallback}, the typical class for a {what}.`, alternatives };
    }
    return { cls: ranked[0].c, basis: "estimated", margin, note: `SigLIP 2 zero-shot over what a {what} can be made of: ${readings} (raw logits, not probabilities; margin ${margin}).`, alternatives };
  }

  private gloss(floor: AppearanceObservation, openingInstances: readonly string[]): Gloss | null {
    const candidates = (floor.reflections ?? []).filter((r) => openingInstances.includes(r.instanceId));
    if (!candidates.length) return null;
    const r = candidates.reduce((a, b) => (b.reflectedPixels > a.reflectedPixels ? b : a));
    const g = MATERIAL_RULES.gloss;
    if (r.contrast >= g.glossyContrast && r.bestBlurDeg !== null) {
      const blur = r.bestBlurDeg;
      const roughness = g.roughnessByBlurDeg.find(([upTo]) => blur <= upTo)![1];
      return {
        glossy: true,
        roughness,
        note: `The opening (${r.instanceId}) is mirrored in the floor: ${round(r.contrast, 0.01)}× brighter there than beside it, and the mirror image matches best blurred by ${blur}°. A glossy finish, roughness ${roughness} by the rule (${g.roughnessByBlurDeg.map(([d, v]) => `≤${d}°: ${v}`).join(", ")}).`,
      };
    }
    if (r.contrast < g.noReflection) {
      return { glossy: false, note: `No mirror image of the opening (${r.instanceId}) is seen in the floor (${round(r.contrast, 0.01)}×): not glossy from this viewpoint.` };
    }
    return { glossy: false, note: `A faint brightening where the floor would mirror the opening (${round(r.contrast, 0.01)}×): inconclusive.` };
  }

  private surfacePattern(cls: MaterialClass, obs: AppearanceObservation): { pattern: SurfacePattern; patternScale?: number; basis: Basis; note?: string } {
    const laid = SURFACE_PATTERN[cls];
    if (!laid) return { pattern: "none", basis: "inferred" };
    if (laid.pattern !== "tiles") return { ...laid, basis: "inferred", note: `A ${cls} floor is laid in ${laid.pattern}; their size is not measured.` };
    const t = MATERIAL_RULES.tiles;
    const axes = obs.texture?.axes ?? [];
    const periods = axes.map((a) => a.period);
    const strong = axes.length === 2 && axes.every((a) => a.period !== null && (a.strength ?? 0) >= t.strength);
    if (strong) {
      const [a, b] = periods as [number, number];
      if (Math.abs(a - b) / Math.max(a, b) <= t.agree) {
        const size = round((a + b) / 2, 0.005);
        return { pattern: "tiles", patternScale: round(size * t.perRepeat), basis: "estimated", note: `Tiles ${size} m square: the rectified floor repeats every ${a} m and ${b} m along the room's axes.` };
      }
    }
    const measured = axes.map((x) => `${x.name} ${x.period ?? "none"} m (strength ${x.strength ?? "–"})`).join(", ");
    return {
      pattern: "tiles",
      patternScale: laid.patternScale,
      basis: "default",
      note: `A ceramic floor is tiled; the tile size is not measured (${measured || "no texture reading"}; both axes must agree within ${t.agree * 100}%), so ${t.defaultSize} m, a common size, is used.`,
    };
  }

  private add(
    id: Id,
    target: string,
    regionId: string,
    resolved: Resolved,
    colour: ColourStats,
    extra: { gloss: Gloss | null; pattern: { pattern: SurfacePattern; patternScale?: number; basis: Basis; note?: string }; colourNote?: string },
  ) {
    const d = CLASS_DEFAULTS[resolved.cls];
    const glossy = extra.gloss?.glossy ? extra.gloss : null;
    const roughness = glossy ? glossy.roughness : d.roughness[1];
    const hex = colour.srgbHex as Hex;
    const material: Material = {
      id,
      class: resolved.cls,
      name: `${d.word}, ${colourName(hex)}${glossy ? ", glossy" : ""}`,
      color: hex,
      roughness,
      metalness: d.metalness,
      pattern: extra.pattern.pattern,
      ...(extra.pattern.patternScale !== undefined ? { patternScale: extra.pattern.patternScale } : {}),
    };
    this.list.push(material);
    const src = [`region:${regionId}`];
    const figured = figuredPattern(colour);
    const fields: Record<string, Quantity<unknown>> = {
      class: q(resolved.cls, resolved.basis, resolved.basis === "estimated" || resolved.margin !== null ? [this.sources.material, ...src] : ["material-rules:" + MATERIAL_RULES.version], resolved.note),
      color: q(hex, "estimated", src, `Apparent colour: ${extra.colourNote ?? "the median of its well-exposed pixels"}, under this photograph's light (not divided out). ${colour.wellExposedPixels.toLocaleString("en-GB")} pixels, spread ΔE ${colour.spreadDeltaE}.`),
      roughness: glossy
        ? q(roughness, "estimated", [...src, "rule:" + MATERIAL_RULES.version], glossy.note)
        : q(roughness, "inferred", ["material-rules:" + MATERIAL_RULES.version], `Typical for ${resolved.cls} (${d.roughness[0]}–${d.roughness[2]}); not measured.${extra.gloss && !glossy ? " " + extra.gloss.note : ""}`),
      metalness: q(d.metalness, "inferred", ["material-rules:" + MATERIAL_RULES.version], `Typical for ${resolved.cls}.`),
      pattern: q(extra.pattern.pattern, extra.pattern.basis, extra.pattern.basis === "estimated" ? src : ["material-rules:" + MATERIAL_RULES.version], extra.pattern.note ?? (extra.pattern.pattern === "none" ? "No pattern is drawn." : `Typical of ${resolved.cls}; not measured.`)),
    };
    if (extra.pattern.patternScale !== undefined) fields.patternScale = q(extra.pattern.patternScale, extra.pattern.basis, fields.pattern.sources, "metres per repeat");
    this.evidence[id] = {
      kind: "material",
      presence: { basis: "estimated" },
      fields,
      observations: [regionId],
      alternatives: resolved.alternatives,
      notes: [
        `Read from the photograph: region ${regionId}.`,
        ...(figured ? [`A figured surface: ${figured}. The renderer draws its median colour.`] : []),
      ],
    };
    this.assigned.push({ materialId: id, target, region: regionId, class: resolved.cls, classBasis: resolved.basis, margin: resolved.margin, roughnessBasis: fields.roughness.basis });
  }

  /** Before appearance was observed (or where it was not): the piece's apparent colour, its category's class. */
  private legacy(objectId: Id, prior: CategoryPrior, inst: InstanceObservation): Id {
    const colour = inst.apparentColour.srgbHex as Hex | null;
    const id = `m-${objectId}`;
    this.list.push({
      id,
      class: prior.materialClass,
      name: `${readable(prior.category)} — apparent colour${colour ? ` ${colour}` : ""}; material not estimated`,
      color: colour ?? "#9a948c",
      roughness: 0.85,
      metalness: 0,
      pattern: "none",
    });
    this.evidence[id] = {
      kind: "material",
      presence: { basis: "default" },
      fields: colour ? { color: q(colour, "measured", [`pixels:${inst.id}`], "median of unclipped mask pixels: the colour under this photo's light, not the material's own") } : {},
      observations: [inst.id],
      notes: ["Apparent colour only; the material itself is not estimated in this version."],
    };
    return id;
  }
}

// ---------------------------------------------------------------------------
// Colour

/** The mean of several regions' logits per class: one reading of a finish seen in several places. */
function meanScores(regions: readonly AppearanceObservation[]): AppearanceObservation["materialClass"] {
  const scored = regions.filter((r) => r.materialClass);
  if (!scored.length) return undefined;
  const sums = new Map<string, number[]>();
  for (const r of scored) for (const s of r.materialClass!.scores) sums.set(s.class, [...(sums.get(s.class) ?? []), s.logit]);
  const scores = [...sums.entries()]
    .map(([cls, logits]) => ({ class: cls, logit: round(logits.reduce((a, b) => a + b, 0) / logits.length, 0.001) }))
    .sort((a, b) => b.logit - a.logit || a.class.localeCompare(b.class));
  return { ...scored[0].materialClass!, scores };
}

function objectPattern(cls: MaterialClass): { pattern: SurfacePattern; patternScale?: number; basis: Basis } {
  const d = CLASS_DEFAULTS[cls];
  return d.pattern === "none" ? { pattern: "none", basis: "inferred" } : { pattern: d.pattern, patternScale: d.patternScale, basis: "inferred" };
}

/** A print or a weave of distinct colours, described; there is no pattern the renderer could draw for it. */
function figuredPattern(colour: ColourStats): string | null {
  const big = colour.palette.filter((p) => p.share >= 0.2);
  if (big.length < 2) return null;
  const [a, b] = big;
  if (deltaE(lab(a.linear), lab(b.linear)) < 25) return null;
  return big.map((p) => `${p.srgbHex} (${Math.round(p.share * 100)}%)`).join(", ");
}

const M = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const WHITE = [0.95047, 1, 1.08883];

function xyz(lin: readonly number[]) {
  return M.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
}

function lab(lin: readonly number[]): [number, number, number] {
  const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const [x, y, z] = xyz(lin).map((v, i) => f(v / WHITE[i]));
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const deltaE = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** CIE 1976 u'v' distance: how far apart two colours' chromaticities are, whatever their brightness. */
export function uvDistance(a: readonly number[], b: readonly number[]) {
  const uv = (lin: readonly number[]) => {
    const [x, y, z] = xyz(lin);
    const d = x + 15 * y + 3 * z || 1e-9;
    return [(4 * x) / d, (9 * y) / d];
  };
  const [ua, va] = uv(a);
  const [ub, vb] = uv(b);
  return Math.hypot(ua - ub, va - vb);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function hexToLinear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}

/** Words for a colour, from its lightness, chroma and hue. Descriptive only. */
export function colourName(hex: string): string {
  const [L, a, b] = lab(hexToLinear(hex));
  const C = Math.hypot(a, b);
  const h = ((Math.atan2(b, a) * DEG) % 360 + 360) % 360;
  const light = L >= 85 ? "pale" : L >= 68 ? "light" : L >= 45 ? "mid" : L >= 25 ? "dark" : "very dark";
  if (C < 6) {
    if (L >= 92) return "white";
    if (L <= 10) return "black";
    const cast = C >= 3 ? (h >= 20 && h < 110 ? "warm " : h >= 170 && h < 300 ? "cool " : "") : "";
    return light === "mid" ? `${cast}grey` : `${light} ${cast}grey`;
  }
  let hue: string;
  if (h < 20 || h >= 345) hue = L >= 70 ? "pink" : "red";
  else if (h < 95) hue = C < 30 ? (L >= 55 ? "beige" : "brown") : L >= 55 ? "orange" : "brown";
  else if (h < 110) hue = C < 20 ? (L >= 60 ? "cream" : "olive") : "yellow";
  else if (h < 170) hue = C < 20 ? "olive" : "green";
  else if (h < 260) hue = C < 15 ? "blue-grey" : "blue";
  else hue = "purple";
  return light === "mid" ? hue : `${light} ${hue}`;
}

function q<T>(value: T, basis: Basis, sources: readonly string[], note?: string): Quantity<T> {
  return { value, basis, sigma: null, interval: null, confidence: null, sources, ...(note ? { note } : {}) };
}

const article = (word: string, capital: boolean) => {
  const a = /^[aeiou]/i.test(word) ? "an" : "a";
  return capital ? a.charAt(0).toUpperCase() + a.slice(1) : a;
};

function readable(category: string) {
  const s = category.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
