import type { Id, Opening, SceneObject, Support, Vec2, Vec3, WallSurface } from "@/scene/model/types";
import type { EntityEvidence } from "./evidence";
import { DEG, round } from "./frame";
import type { Basis, InstanceObservation, PlaneObservation, Problem, Quantity, ReconstructionIntermediate } from "./intermediate";
import type { MaterialBook } from "./materials";
import { OBJECT_RULES, PRIORS_BY_CATEGORY, VOCABULARY, type CategoryPrior } from "./vocabulary";

/**
 * Objects, openings and the lights that follow from them
 * ================================================================
 * Each piece in the Scene is one instance the detector found in the
 * photograph, above the score bar, whose mask the segmenter trusted and
 * whose phrase the vocabulary can represent. It is drawn by the renderer's
 * parametric builder for its category, at the size and place its visible
 * points give, and each number says how it is known:
 *
 * - the visible extents are estimates, and lower bounds;
 * - a dimension the camera could not see (usually depth, since a piece is
 *   seen from the front) comes from the category's typical size, `inferred`;
 * - which way it faces is a rule applied to evidence, `inferred`: away from
 *   a wall it stands against, otherwise the way its visible faces point;
 * - things on walls (pictures, curtains, a wall-hung TV, openings) are
 *   measured on the wall plane itself, from their pixels' rays.
 *
 * Nothing is added that was not seen, and a phrase with no representation
 * is reported as seen and not modelled, never forced into a category.
 */

export interface ShellFrame {
  s: number;
  sizeBasis: Basis;
  yawDeg: number;
  /** Capture frame → Scene frame (yaw, scale, centring). */
  toScene: (p: Vec3) => Vec3;
  /** Capture-frame direction → Scene-frame direction (yaw only). */
  dirToScene: (v: Vec3) => Vec3;
  bounds: { xMin: number; xMax: number; zMin: number; zMax: number; height: number };
  camera: Vec3;
  walls: readonly WallSurface[];
  /** Which Scene wall a fitted wall plane became. */
  wallOfPlane: Readonly<Record<string, Id>>;
  sources: { geometry: string; detection: string; segmentation: string };
  /** Where every material of this compile is made and recorded. */
  book: MaterialBook;
}

export interface ObjectsReport {
  rulesVersion: string;
  vocabularyVersion: string;
  emitted: readonly { id: Id; instance: string; label: string; score: number; category: string }[];
  openings: readonly { id: Id; instance: string; label: string; score: number; kind: string; wallId: Id }[];
  candidates: readonly { instance: string; label: string; score: number }[];
  notModelled: readonly { instance: string; label: string; score: number; reason: string }[];
  rejected: readonly { instance: string; label: string; score: number; reason: string }[];
}

export interface ObjectsResult {
  objects: SceneObject[];
  openings: Opening[];
  /** Each opening with the instance it was built from, for the light and the floor's gloss. */
  openingInstances: { opening: Opening; instance: string }[];
  entities: Record<Id, EntityEvidence>;
  problems: Problem[];
  report: ObjectsReport;
  /** Placement facts the relationship rules read. */
  placed: Placed[];
}

export interface Placed {
  object: SceneObject;
  prior: CategoryPrior;
  front: Vec2;
  /** Side of the room it stands against, if any. */
  against: Id | null;
  onWall: Id | null;
}

type Side = "left" | "right" | "far" | "behind";
const INWARD: Record<Side, Vec2> = { left: [1, 0], right: [-1, 0], far: [0, 1], behind: [0, -1] };

interface Draft {
  inst: InstanceObservation;
  label: string;
  score: number;
  prior: CategoryPrior;
  center: [number, number, number];
  front: Vec2;
  width: number;
  height: number;
  depth: number;
  bases: { width: Basis; height: Basis; depth: Basis; position: Basis; rotation: Basis };
  support: Support | { kind: "object-draft"; draft: Draft };
  against: Id | null;
  onWall: Id | null;
  base: number;
  notes: string[];
  metadata: Record<string, string | number | boolean>;
}

export function compileObjects(input: ReconstructionIntermediate, shell: ShellFrame): ObjectsResult {
  const report = {
    rulesVersion: OBJECT_RULES.version,
    vocabularyVersion: VOCABULARY.version,
    emitted: [] as { id: Id; instance: string; label: string; score: number; category: string }[],
    openings: [] as { id: Id; instance: string; label: string; score: number; kind: string; wallId: Id }[],
    candidates: [] as { instance: string; label: string; score: number }[],
    notModelled: [] as { instance: string; label: string; score: number; reason: string }[],
    rejected: [] as { instance: string; label: string; score: number; reason: string }[],
  };
  const problems: Problem[] = [];
  const planes = input.world.planes;
  const drafts: Draft[] = [];
  const openingDrafts: { inst: InstanceObservation; label: string; score: number; glazed: boolean; door: boolean; wall: WallSurface; t0: number; t1: number; bottom: number; top: number }[] = [];

  for (const inst of input.world.instances ?? []) {
    const best = inst.labels[0];
    const note = { instance: inst.id, label: best.label, score: inst.score };
    if (inst.score < OBJECT_RULES.candidateScore) continue;
    if (inst.score < OBJECT_RULES.emitScore) {
      report.candidates.push(note);
      continue;
    }
    const meaning = VOCABULARY.phrases[best.label];
    if (!meaning) {
      report.rejected.push({ ...note, reason: "phrase not in the vocabulary" });
      continue;
    }
    if (meaning.kind === "unmodelled") {
      report.notModelled.push({ ...note, reason: meaning.reason });
      continue;
    }
    if (meaning.kind === "opening") {
      const host = hostWall(inst, shell);
      const ring = inst.wallContact.find((c) => c.planeId === inst.wallProjection?.planeId)?.ringFraction ?? 0;
      if (!host || ring < OBJECT_RULES.openingRing) {
        report.rejected.push({ ...note, reason: "not set in one of the room's walls (seen through glass, or on a wall that was not fitted)" });
        continue;
      }
      const [t0, t1] = alongWall(inst, host, planes, shell);
      const [v0, v1] = inst.wallProjection!.v;
      openingDrafts.push({ inst, label: best.label, score: inst.score, glazed: meaning.glazed, door: meaning.opening === "door", wall: host, t0, t1, bottom: v0 * shell.s, top: v1 * shell.s });
      continue;
    }
    if (inst.mask.score < OBJECT_RULES.maskScore) {
      report.rejected.push({ ...note, reason: `mask not trusted (segmenter score ${round(inst.mask.score, 0.01)})` });
      continue;
    }
    let prior: CategoryPrior;
    const notes: string[] = [];
    if (meaning.kind === "lamp") {
      const top = (inst.heightRange?.[1] ?? 0) * shell.s;
      if (top < OBJECT_RULES.floorLampTop) {
        report.notModelled.push({ ...note, reason: "a table lamp; this version has no table-lamp builder" });
        continue;
      }
      prior = PRIORS_BY_CATEGORY["floor-lamp"];
      notes.push(`The detector read “${best.label}”; its top is ${round(top, 0.01)} m above the floor, so it is represented as a floor lamp.`);
    } else {
      prior = meaning.prior;
    }

    const onWall = prior.mount === "wall" || (prior.mount === "tv" && tvOnWall(inst, shell));
    const draft = onWall ? wallDraft(inst, best.label, prior, planes, shell, notes) : floorDraft(inst, best.label, prior, shell, notes);
    if (typeof draft === "string") {
      report.rejected.push({ ...note, reason: draft });
      continue;
    }
    drafts.push(draft);
  }

  restOnPieces(drafts);
  for (const d of drafts) seatHeight(d, shell);

  // Ids from content and order, so they survive a recalibration unchanged.
  drafts.sort((a, b) => a.prior.category.localeCompare(b.prior.category) || a.center[0] - b.center[0] || a.center[2] - b.center[2] || a.inst.id.localeCompare(b.inst.id));
  const counts = new Map<string, number>();
  drafts.forEach((d) => counts.set(d.prior.category, (counts.get(d.prior.category) ?? 0) + 1));
  const seen = new Map<string, number>();
  const idOf = new Map<Draft, Id>();
  for (const d of drafts) {
    const n = seen.get(d.prior.category) ?? 0;
    seen.set(d.prior.category, n + 1);
    idOf.set(d, `${d.prior.category}-${n}`);
  }

  const entities: Record<Id, EntityEvidence> = {};
  const objects: SceneObject[] = [];
  const placed: Placed[] = [];
  for (const d of drafts) {
    const id = idOf.get(d)!;
    const n = Number(id.slice(id.lastIndexOf("-") + 1));
    const many = (counts.get(d.prior.category) ?? 0) > 1;
    const label = `${readable(d.prior.category)}${many ? ` ${n + 1}` : ""}`;
    const slots = shell.book.objectSlots(id, d.prior, d.inst);
    const support: Support =
      d.support.kind === "object-draft" ? { kind: "object", objectId: idOf.get(d.support.draft)! } : d.support;
    const rotationY = round(Math.atan2(d.front[0], d.front[1]), 0.0001);
    const object: SceneObject = {
      id,
      category: d.prior.category,
      label,
      transform: { position: [round(d.center[0]), round(d.center[1]), round(d.center[2])], rotation: [0, rotationY, 0], scale: [1, 1, 1] },
      dimensions: [round(d.width), round(d.height), round(d.depth)],
      materials: slots,
      support,
      ...(d.prior.form ? { form: d.prior.form } : {}),
      metadata: { reconstructed: true, instance: d.inst.id, detectorScore: round(d.score, 0.0001), ...d.metadata },
    };
    objects.push(object);
    placed.push({ object, prior: d.prior, front: d.front, against: d.against, onWall: d.onWall });
    report.emitted.push({ id, instance: d.inst.id, label: d.label, score: d.score, category: d.prior.category });
    entities[id] = objectEvidence(d, object, shell);
  }

  // Curtains hung on one wall are one fabric, however differently the window lights them.
  const slot = PRIORS_BY_CATEGORY.curtain.primarySlot;
  const byWall = new Map<Id, SceneObject[]>();
  for (const o of objects) {
    if (o.category === "curtain" && o.support.kind === "wall") byWall.set(o.support.wallId, [...(byWall.get(o.support.wallId) ?? []), o]);
  }
  for (const hung of byWall.values()) {
    if (hung.length < 2) continue;
    const to = shell.book.unify(hung.map((o) => o.materials[slot]), "Curtains hung on one wall");
    for (const o of hung) {
      const next = to[o.materials[slot]];
      if (!next || next === o.materials[slot]) continue;
      const updated: SceneObject = { ...o, materials: { ...o.materials, [slot]: next } };
      objects[objects.indexOf(o)] = updated;
      const p = placed.find((x) => x.object === o);
      if (p) p.object = updated;
    }
  }

  // Openings -------------------------------------------------------------------
  openingDrafts.sort((a, b) => a.wall.id.localeCompare(b.wall.id) || a.t0 - b.t0);
  const openings: Opening[] = [];
  const openingInstances: { opening: Opening; instance: string }[] = [];
  for (const [i, o] of openingDrafts.entries()) {
    const kind = o.glazed ? "window" : "door";
    const id = `${kind}-${i}`;
    const wallLength = Math.hypot(o.wall.end[0] - o.wall.start[0], o.wall.end[1] - o.wall.start[1]);
    const t0 = Math.max(0, Math.min(o.t0, o.t1));
    const t1 = Math.min(wallLength, Math.max(o.t0, o.t1));
    const sillBasis: Basis = o.door ? "inferred" : shell.sizeBasis;
    const sill = o.door ? 0 : Math.max(0, o.bottom);
    const top = Math.min(o.top, shell.bounds.height - 0.02);
    const finish = shell.book.opening(id, o.inst, o.glazed);
    const opening: Opening = {
      id,
      kind,
      label: o.door ? (o.glazed ? "Glazed door" : "Door") : "Window",
      wallId: o.wall.id,
      offset: round((t0 + t1) / 2),
      width: round(t1 - t0),
      height: round(top - sill),
      sill: round(sill),
      ...finish,
    };
    openings.push(opening);
    openingInstances.push({ opening, instance: o.inst.id });
    report.openings.push({ id, instance: o.inst.id, label: o.label, score: o.score, kind, wallId: o.wall.id });
    const noteLines = [`Detected as “${o.label}” (score ${round(o.score, 0.01)}), set in the ${o.wall.label.toLowerCase()}; measured on the wall plane from its pixels' rays.`];
    if (o.door && o.bottom > 0.1) noteLines.push(`Its lower part is hidden (the visible glass starts ${round(o.bottom, 0.01)} m up); a door reaches the floor, so the sill is taken as 0.`);
    entities[id] = {
      kind: "opening",
      presence: { basis: "estimated" },
      fields: {
        width: q(opening.width, shell.sizeBasis, [shell.sources.segmentation, `plane:${o.inst.wallProjection!.planeId}`]),
        height: q(opening.height, o.door ? "inferred" : shell.sizeBasis, [shell.sources.segmentation]),
        sill: q(opening.sill, sillBasis, o.door ? ["rule:doors-reach-the-floor"] : [shell.sources.segmentation]),
        kind: q(kind, "estimated", [shell.sources.detection], `detector phrases: ${o.inst.labels.map((l) => `${l.label} ${l.score}`).join(", ")}`),
      },
      observations: [o.inst.id],
      notes: noteLines,
    };
  }
  return { objects, openings, openingInstances, entities, problems, report, placed };
}

// ---------------------------------------------------------------------------
// Placement

function floorDraft(inst: InstanceObservation, label: string, prior: CategoryPrior, shell: ShellFrame, notes: string[]): Draft | string {
  if (inst.geometry !== "ok" || !inst.visibleBox || !inst.heightRange) return "too few 3D points in its mask";
  const s = shell.s;
  const box = inst.visibleBox;
  const c = shell.toScene(box.center);
  const a = (box.yawDeg - shell.yawDeg) / DEG;
  const u: Vec2 = [Math.cos(a), Math.sin(a)];
  const v: Vec2 = [-Math.sin(a), Math.cos(a)];
  const su = box.size[0] * s;
  const sv = box.size[2] * s;
  const top = inst.heightRange[1] * s;
  const bottom = inst.heightRange[0] * s;
  const halfOf = (dir: Vec2, width: number, depth: number): Vec2 => {
    const side: Vec2 = [dir[1], -dir[0]];
    return [
      (Math.abs(side[0]) * width + Math.abs(dir[0]) * depth) / 2,
      (Math.abs(side[1]) * width + Math.abs(dir[1]) * depth) / 2,
    ];
  };

  const candidates: { dir: Vec2; depth: number; width: number }[] = [
    { dir: u, depth: su, width: sv },
    { dir: [-u[0], -u[1]], depth: su, width: sv },
    { dir: v, depth: sv, width: su },
    { dir: [-v[0], -v[1]], depth: sv, width: su },
  ];
  const nearest = nearestSide(c, halfOf(u, sv, su), shell);
  let chosen = candidates[0];
  let rotationNote: string;
  let against: Side | null = null;
  if (prior.backToWall && nearest.gap < OBJECT_RULES.againstWall) {
    against = nearest.side;
    chosen = best(candidates, INWARD[nearest.side]);
    rotationNote = `It stands against the ${nearest.side} wall, so it faces away from it.`;
  } else if (inst.frontNormal) {
    const f = shell.dirToScene(inst.frontNormal);
    chosen = best(candidates, [f[0], f[2]]);
    rotationNote = "Turned the way its visible faces point; the side seen may be its back.";
  } else {
    chosen = best(candidates, [shell.camera[0] - c[0], shell.camera[2] - c[2]]);
    rotationNote = "Turned towards the camera: nothing else says which way it faces.";
  }
  const truncated = Object.values(inst.touchesImageBorder).some(Boolean);
  // Part of it went unseen: cut off by the edge of the photograph.
  const partial = truncated;
  const bases = { width: shell.sizeBasis, height: shell.sizeBasis, depth: shell.sizeBasis, position: shell.sizeBasis, rotation: "inferred" as Basis };
  const why = "it is cut off by the edge of the photograph";

  let width = chosen.width;
  if (width < prior.width[0] && partial) {
    width = prior.width[1];
    bases.width = "inferred";
    notes.push(`Narrower than any ${readable(prior.category).toLowerCase()} because ${why}: its width is a typical one.`);
  }
  let depth = chosen.depth;
  if (depth < prior.depth[0]) {
    depth = prior.depth[1];
    bases.depth = "inferred";
    notes.push(`Its back was not seen, so its depth (${round(depth, 0.01)} m) is a typical ${readable(prior.category).toLowerCase()}'s.`);
  }
  let height = top;
  if (height < prior.height[0] && partial) {
    height = prior.height[1];
    bases.height = "inferred";
    notes.push(`Lower than any ${readable(prior.category).toLowerCase()} because ${why}: its height is a typical one.`);
  }
  if (bottom > OBJECT_RULES.offFloor && prior.mount === "floor") {
    notes.push(`Its base is hidden (the lowest part seen is ${round(bottom, 0.01)} m up); it is taken to stand on the floor.`);
  }

  // The visible face is the front: extend the hidden part behind it.
  const faceX = c[0] + chosen.dir[0] * (chosen.depth / 2);
  const faceZ = c[2] + chosen.dir[1] * (chosen.depth / 2);
  let x = faceX - chosen.dir[0] * (depth / 2);
  let z = faceZ - chosen.dir[1] * (depth / 2);
  if (against) {
    // Back against the wall it stands by.
    const [nx, nz] = INWARD[against];
    const b = shell.bounds;
    if (nx) x = (nx > 0 ? b.xMin : b.xMax) + nx * (depth / 2 + 0.01);
    if (nz) z = (nz > 0 ? b.zMin : b.zMax) + nz * (depth / 2 + 0.01);
  }
  const [hx, hz] = halfOf(chosen.dir, width, depth);
  const b = shell.bounds;
  const cx = clampInside(x, b.xMin + hx, b.xMax - hx);
  const cz = clampInside(z, b.zMin + hz, b.zMax - hz);
  if (Math.hypot(cx - x, cz - z) > 0.05) notes.push(`Moved ${round(Math.hypot(cx - x, cz - z), 0.01)} m to keep it inside the room.`);
  notes.push(rotationNote);

  return {
    inst,
    label,
    score: inst.score,
    prior,
    center: [cx, 0, cz],
    front: chosen.dir,
    width,
    height,
    depth,
    bases,
    support: { kind: "floor" },
    against: against ? `wall-${against}` : null,
    onWall: null,
    base: bottom,
    notes,
    metadata: {},
  };
}

function wallDraft(inst: InstanceObservation, label: string, prior: CategoryPrior, planes: readonly PlaneObservation[], shell: ShellFrame, notes: string[]): Draft | string {
  const wall = hostWall(inst, shell);
  if (!wall) return "hangs on a wall that is not one of the room's fitted walls";
  const [t0, t1] = alongWall(inst, wall, planes, shell);
  const [v0, v1] = inst.wallProjection!.v;
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const dir: Vec2 = [(wall.end[0] - wall.start[0]) / length, (wall.end[1] - wall.start[1]) / length];
  const inward = inwardOf(wall);
  const lo = Math.max(0, Math.min(t0, t1));
  const hi = Math.min(length, Math.max(t0, t1));
  const mid = (lo + hi) / 2;
  const depth = prior.depth[1];
  const bottom = Math.max(0, v0 * shell.s);
  const height = Math.min(v1 * shell.s, shell.bounds.height) - bottom;
  notes.push(`Measured on the ${wall.label.toLowerCase()} from its pixels' rays; its thickness (${depth} m) is a typical one.`);
  return {
    inst,
    label,
    score: inst.score,
    prior,
    center: [wall.start[0] + dir[0] * mid + inward[0] * (depth / 2 + 0.005), bottom, wall.start[1] + dir[1] * mid + inward[1] * (depth / 2 + 0.005)],
    front: inward,
    width: hi - lo,
    height,
    depth,
    bases: { width: shell.sizeBasis, height: shell.sizeBasis, depth: "inferred", position: shell.sizeBasis, rotation: "inferred" },
    support: { kind: "wall", wallId: wall.id },
    against: wall.id,
    onWall: wall.id,
    base: bottom,
    notes,
    metadata: prior.category === "television" ? { mount: "wall" } : {},
  };
}

/** A small thing whose base is well off the floor sits on the piece beneath it, if one is there. */
function restOnPieces(drafts: Draft[]) {
  for (const d of drafts) {
    if (d.support.kind !== "floor" || d.base <= OBJECT_RULES.offFloor) continue;
    if (d.prior.mount !== "floor-or-object" && d.prior.mount !== "tv") continue;
    const under = drafts
      .filter((o) => o !== d && o.support.kind === "floor" && o.prior.mount === "floor")
      .filter((o) => Math.abs(o.height - d.base) < OBJECT_RULES.restsOnTolerance && inside(d.center, o))
      .sort((a, b) => Math.abs(a.height - d.base) - Math.abs(b.height - d.base))[0];
    if (!under) continue;
    d.support = { kind: "object-draft", draft: under };
    d.center[1] = under.height;
    d.height = Math.max(0.05, d.height - under.height);
    d.notes.push(`It rests on the ${readable(under.prior.category).toLowerCase()} beneath it.`);
    if (d.prior.category === "television") d.metadata.mount = "stand";
  }
}

/** Sofa and armchair seat height: the highest of its own horizontal surfaces at seat height. */
function seatHeight(d: Draft, shell: ShellFrame) {
  if (d.prior.category !== "sofa" && d.prior.category !== "armchair") return;
  if (d.bases.height === "inferred") return; // a seat measured on a piece whose height was not is not trusted
  const seat = (d.inst.horizontalSurfaces ?? [])
    .map((s) => s.height * shell.s)
    .filter((h) => h > 0.3 && h < 0.65 && h < d.height - 0.1)
    .sort((a, b) => b - a)[0];
  if (seat === undefined) {
    d.notes.push("No seat surface was measured; the seat height is the builder's.");
    return;
  }
  d.metadata.seatHeight = round(seat);
  d.notes.push(`Its seat height (${round(seat, 0.01)} m) is its own horizontal surface at that height.`);
}

function tvOnWall(inst: InstanceObservation, shell: ShellFrame) {
  const host = hostWall(inst, shell);
  const contact = inst.wallContact.find((c) => c.planeId === inst.wallProjection?.planeId);
  const base = (inst.heightRange?.[0] ?? inst.wallProjection?.v[0] ?? 0) * shell.s;
  return Boolean(host && contact && contact.pointFraction >= OBJECT_RULES.tvOnWallFraction && base > OBJECT_RULES.tvOnWallBase);
}

function hostWall(inst: InstanceObservation, shell: ShellFrame): WallSurface | null {
  const planeId = inst.wallProjection?.planeId;
  const wallId = planeId ? shell.wallOfPlane[planeId] : undefined;
  return (wallId && shell.walls.find((w) => w.id === wallId)) || null;
}

/** The instance's extent along its Scene wall, as distances from the wall's start. */
function alongWall(inst: InstanceObservation, wall: WallSurface, planes: readonly PlaneObservation[], shell: ShellFrame): [number, number] {
  const projection = inst.wallProjection!;
  const plane = planes.find((p) => p.id === projection.planeId)!;
  const foot: Vec3 = [-plane.offset * plane.normal[0], 0, -plane.offset * plane.normal[2]];
  const axis = plane.visibleExtent.axes.u;
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const dir: Vec2 = [(wall.end[0] - wall.start[0]) / length, (wall.end[1] - wall.start[1]) / length];
  const at = (u: number) => {
    const e = shell.toScene([foot[0] + axis[0] * u, 0, foot[2] + axis[2] * u]);
    return (e[0] - wall.start[0]) * dir[0] + (e[2] - wall.start[1]) * dir[1];
  };
  return [at(projection.u[0]), at(projection.u[1])];
}

function nearestSide(c: Vec3, half: Vec2, shell: ShellFrame): { side: Side; gap: number } {
  const b = shell.bounds;
  const gaps: [Side, number][] = [
    ["left", c[0] - half[0] - b.xMin],
    ["right", b.xMax - (c[0] + half[0])],
    ["far", c[2] - half[1] - b.zMin],
    ["behind", b.zMax - (c[2] + half[1])],
  ];
  const [side, gap] = gaps.reduce((a, g) => (g[1] < a[1] ? g : a));
  return { side, gap };
}

function best<T extends { dir: Vec2 }>(candidates: readonly T[], towards: Vec2): T {
  return candidates.reduce((a, c) => (c.dir[0] * towards[0] + c.dir[1] * towards[1] > a.dir[0] * towards[0] + a.dir[1] * towards[1] ? c : a));
}

function inwardOf(wall: WallSurface): Vec2 {
  const dx = wall.end[0] - wall.start[0];
  const dz = wall.end[1] - wall.start[1];
  const len = Math.hypot(dx, dz);
  let n: Vec2 = [-dz / len, dx / len];
  const mx = (wall.start[0] + wall.end[0]) / 2;
  const mz = (wall.start[1] + wall.end[1]) / 2;
  // The footprint is centred on the origin, so inward is towards it.
  if (n[0] * -mx + n[1] * -mz < 0) n = [-n[0], -n[1]];
  return n;
}

/** Whether a point lies over a draft's footprint. */
function inside(p: readonly number[], d: Draft) {
  const dx = p[0] - d.center[0];
  const dz = p[2] - d.center[2];
  const along = dx * d.front[0] + dz * d.front[1];
  const across = dx * d.front[1] - dz * d.front[0];
  return Math.abs(along) <= d.depth / 2 && Math.abs(across) <= d.width / 2;
}

const clampInside = (value: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, value)));

function objectEvidence(d: Draft, object: SceneObject, shell: ShellFrame): EntityEvidence {
  const src = [shell.sources.detection, shell.sources.segmentation, shell.sources.geometry];
  const fields: Record<string, Quantity<unknown>> = {
    category: q(object.category, "estimated", [shell.sources.detection], `detector phrase “${d.label}”, raw score ${round(d.score, 0.001)}`),
    "dimensions.0": q(object.dimensions[0], d.bases.width, src, "width, from the visible points (a lower bound)"),
    "dimensions.1": q(object.dimensions[1], d.bases.height, src, "height"),
    "dimensions.2": q(object.dimensions[2], d.bases.depth, d.bases.depth === "inferred" ? ["vocabulary:" + VOCABULARY.version] : src, "depth"),
    "transform.position": q(object.transform.position, d.bases.position, src),
    "transform.rotation.1": q(round(object.transform.rotation[1] * DEG, 0.01), d.bases.rotation, ["rule:" + OBJECT_RULES.version], "degrees"),
    support: q(object.support.kind, d.support.kind === "floor" && d.base > OBJECT_RULES.offFloor ? "inferred" : "estimated", ["rule:" + OBJECT_RULES.version]),
  };
  if (object.form) fields.form = q(object.form, "default", ["vocabulary:" + VOCABULARY.version], "the builder's default form; the form is not estimated");
  if (typeof d.metadata.seatHeight === "number") fields["metadata.seatHeight"] = q(d.metadata.seatHeight, shell.sizeBasis, src);
  return {
    kind: "object",
    presence: { basis: "estimated" },
    fields,
    observations: [d.inst.id],
    alternatives: d.inst.labels.slice(1).map((l) => ({ field: "category", value: l.label, score: l.score })),
    notes: [`Seen in the photograph: “${d.label}”, detector score ${round(d.score, 0.01)} (raw, not a probability); mask score ${round(d.inst.mask.score, 0.01)}.`, ...d.notes],
  };
}

function q<T>(value: T, basis: Basis, sources: readonly string[], note?: string): Quantity<T> {
  return { value, basis, sigma: null, interval: null, confidence: null, sources, ...(note ? { note } : {}) };
}

function readable(category: string) {
  const s = category.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
