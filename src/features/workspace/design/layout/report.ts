import { findById, walls } from "@/scene/model/queries";
import type { Id, Relationship, RelationPredicate, Scene, SceneObject, Vec2 } from "@/scene/model/types";
import type { ProposedChange } from "../../ai/interpreter";
import { footprintOf, separation } from "../../ai/rules/spatial";
import { angleOf, intrusion, nearestWallOf, PASSAGE, poseOf, turnBetween, wrap } from "./geometry";
import type { LayoutStyle } from "./intent";
import type { LayoutPlan } from "./planner";
import { whyItStays } from "./roles";
import type { LayoutContext, LayoutReading } from "./strategies";

/**
 * A layout, said in the person's terms.
 * ================================================================
 *
 * What each moved piece does, why the direction asked for it, what it
 * leaves alone, and what it changes about the room as a whole — its
 * relationships and its walkable floor — each read from the room before and
 * after. Nothing here ranks one layout against another.
 */

export interface LayoutSummary {
  style: LayoutStyle;
  reading: string;
  moved: readonly Id[];
  /** Relationships among the seating and the screen, recomputed by the compiler's rules. */
  relationships: { gained: readonly string[]; lost: readonly string[]; kept: readonly string[] };
  circulation: { walkableBefore: number; walkableAfter: number; openBefore: number; openAfter: number };
}

export interface LayoutReport {
  changes: ProposedChange[];
  rationale: string[];
  constraints: string[];
  summary: LayoutSummary;
}

/** Within this of a target, a piece is said to face it. */
export const FACING = (15 * Math.PI) / 180;

/** The relationships a layout is about: who sits facing what, what stands in front of whom, what is against a wall. */
const TOLD: readonly RelationPredicate[] = ["faces", "in-front-of", "beside", "against"];

export function describeLayout(ctx: LayoutContext, reading: LayoutReading, plan: LayoutPlan): LayoutReport {
  const { before, after } = plan;
  const label = (scene: Scene, id: Id) => (findById(scene.objects, id) ?? findById(walls(scene), id))?.label.toLowerCase() ?? id;
  const say = (r: Relationship) => `the ${label(after, r.subjectId)} ${PHRASE[r.predicate]} the ${label(after, r.objectId)}`;
  const key = (r: Relationship) => `${r.subjectId}|${r.predicate}|${r.objectId}`;
  const was = new Set(plan.relationships.before.filter((r) => TOLD.includes(r.predicate)).map(key));
  const now = new Set(plan.relationships.after.filter((r) => TOLD.includes(r.predicate)).map(key));
  const touched = (r: Relationship) => plan.moved.includes(r.subjectId) || plan.moved.includes(r.objectId);
  const gained = plan.relationships.after.filter((r) => TOLD.includes(r.predicate) && !was.has(key(r))).map(say);
  const lost = plan.relationships.before.filter((r) => TOLD.includes(r.predicate) && !now.has(key(r)) && touched(r)).map(say);
  const kept = plan.relationships.before.filter((r) => (r.predicate === "faces" || r.predicate === "in-front-of") && now.has(key(r))).map(say);

  const changes = plan.steps.map(({ id, operations }): ProposedChange => {
    const piece = findById(before.objects, id)!;
    return { id: `layout-${id}`, group: "Layout", target: piece.label, detail: detailOf(ctx, piece, findById(after.objects, id)!, after), operations };
  });

  const { circulation } = plan;
  const rationale = [opening(ctx, reading, before), ...stayed(ctx, reading, plan)];
  if (gained.length) rationale.push(`Now ${list(gained)}.`);
  if (kept.length) rationale.push(`Kept: ${list(kept)}.`);
  if (lost.length) rationale.push(`No longer: ${list(lost)}.`);
  rationale.push(`Walkable floor, by a 60 cm path from the way in: ${m2(circulation.before.walkableArea)} → ${m2(circulation.after.walkableArea)}.`);
  for (const passage of circulation.after.passages) {
    const opening = findById(after.openings, passage.openingId)!.label.toLowerCase();
    const cleared = (circulation.before.passages.find((p) => p.openingId === passage.openingId)?.blockedBy ?? []).filter((b) => !passage.blockedBy.includes(b));
    if (cleared.length) rationale.push(`The ${list(cleared.map((b) => label(after, b)))} no longer ${cleared.length === 1 ? "stands" : "stand"} in front of the ${opening}.`);
    const left = passage.blockedBy.filter((b) => !plan.moved.includes(b));
    if (left.length) rationale.push(`The ${list(left.map((b) => label(after, b)))} still ${left.length === 1 ? "stands" : "stand"} in front of the ${opening}; this direction leaves it where it is.`);
  }

  return {
    changes,
    rationale,
    constraints: constraintsOf(ctx, plan),
    summary: {
      style: reading.style,
      reading: reading.key,
      moved: plan.moved,
      relationships: { gained, lost, kept },
      circulation: {
        walkableBefore: circulation.before.walkableArea,
        walkableAfter: circulation.after.walkableArea,
        openBefore: circulation.before.openArea,
        openAfter: circulation.after.openArea,
      },
    },
  };
}

const PHRASE: Readonly<Record<RelationPredicate, string>> = {
  faces: "faces",
  "in-front-of": "stands in front of",
  beside: "stands beside",
  against: "stands against",
  on: "stands on",
  under: "stands under",
  above: "hangs above",
  "lit-by": "is lit by",
  opposite: "stands opposite",
};

/** One piece's change: how far it went, where to, which way it turned and to face what. */
function detailOf(ctx: LayoutContext, from: SceneObject, to: SceneObject, after: Scene): string {
  const a = poseOf(from);
  const b = poseOf(to);
  const distance = Math.hypot(b.at[0] - a.at[0], b.at[2] - a.at[2]);
  const turn = (wrap(b.rotationY - a.rotationY) * 180) / Math.PI;
  const parts: string[] = [];
  const f = footprintOf(to);
  if (distance >= 0.03) {
    const wall = nearestWallOf(after, f);
    const table = ctx.table && ctx.table.id !== to.id ? findById(after.objects, ctx.table.id) : null;
    const where = wall && wall.gap < 0.1 ? ` to the ${wall.wall.label.toLowerCase()}` : table && separation(f, footprintOf(table)) < 0.6 ? ` up to the ${table.label.toLowerCase()}` : "";
    parts.push(`moved ${length(distance)}${where}`);
  }
  if (Math.abs(turn) >= 2) {
    const c: Vec2 = [b.at[0], b.at[2]];
    const facing = (target: SceneObject | null) => target && target.id !== to.id && turnBetween(b.rotationY, angleOf([target.transform.position[0] - c[0], target.transform.position[2] - c[1]])) < FACING;
    const table = ctx.table && findById(after.objects, ctx.table.id);
    const primary = ctx.primary && findById(after.objects, ctx.primary.id);
    const why = facing(ctx.display) ? ` to face the ${ctx.display!.label.toLowerCase()}` : facing(table ?? null) ? ` towards the ${table!.label.toLowerCase()}` : facing(primary ?? null) ? ` towards the ${primary!.label.toLowerCase()}` : "";
    parts.push(`turned ${Math.round(Math.abs(turn))}°${why}`);
  }
  for (const { opening, zone } of ctx.zones) {
    if (intrusion(footprintOf(from), zone) > PASSAGE.tolerance && intrusion(f, zone) <= PASSAGE.tolerance) parts.push(`out of the way of the ${opening.label.toLowerCase()}`);
  }
  return parts.join(", ") || "set straight";
}

/** What the direction set out to do, in this room's terms. */
function opening(ctx: LayoutContext, reading: LayoutReading, before: Scene): string {
  const display = ctx.display;
  switch (reading.style) {
    case "TV_FOCUSED": {
      const wall = display?.support.kind === "wall" ? findById(walls(before), display.support.wallId)?.label.toLowerCase() : null;
      return `The ${display?.label.toLowerCase() ?? "screen"}${wall ? ` hangs on the ${wall}` : " stands where it is"}; seats that did not face it are turned or moved into its view, clear of the line between the ${ctx.primary?.label.toLowerCase() ?? "main seat"} and the screen.`;
    }
    case "CONVERSATION":
      return `Seats are turned in round ${ctx.table ? `the ${ctx.table.label.toLowerCase()}` : "a shared centre"}${reading.params.radius ? `, ${reading.params.radius[0].toFixed(1)}–${reading.params.radius[1].toFixed(1)} m from it` : ""}, so the people in them face one another.`;
    default:
      return reading.params.entranceOnly
        ? `Only what stands in front of the ${ctx.zones[0]?.opening.label.toLowerCase() ?? "way in"} moves, to the nearest place that keeps it useful.`
        : "Movable pieces are drawn back towards the walls, turned to face into the room, so the middle of the floor is left clear.";
  }
}

/** The pieces the direction cared about that it left alone, and why. */
function stayed(ctx: LayoutContext, reading: LayoutReading, plan: LayoutPlan): string[] {
  const out: string[] = [];
  const primary = ctx.primary;
  if (primary && !plan.moved.includes(primary.id)) {
    const display = ctx.display;
    if (reading.style === "TV_FOCUSED" && display) {
      const off = turnBetween(primary.transform.rotation[1], angleOf([display.transform.position[0] - primary.transform.position[0], display.transform.position[2] - primary.transform.position[2]]));
      out.push(`The ${primary.label.toLowerCase()} already faces the ${display.label.toLowerCase()} (${Math.round((off * 180) / Math.PI)}° off it), so it stays where it is.`);
    } else {
      out.push(`The ${primary.label.toLowerCase()} stays where it is${ctx.table ? `, with the ${ctx.table.label.toLowerCase()} in front of it` : ""}: the room is arranged from it.`);
    }
  }
  return out;
}

function constraintsOf(ctx: LayoutContext, plan: LayoutPlan): string[] {
  const out = [`Only the ${plan.moved.length === 1 ? "piece" : `${plan.moved.length} pieces`} listed ${plan.moved.length === 1 ? "moves" : "move"}; everything else stays exactly where it is`, "Nothing is added or taken away"];
  const hung = ctx.scene.objects.filter((o) => ctx.roles.get(o.id)?.mobility === "wall-mounted");
  if (hung.length) out.push(`Wall-hung pieces stay on their walls: ${list(counted(hung))}`);
  for (const object of ctx.scene.objects) {
    const role = ctx.roles.get(object.id);
    if (role?.mobility === "anchored") out.push(`The ${object.label.toLowerCase()} stays where it is: ${whyItStays(role)}`);
  }
  out.push("Walkable floor is a design heuristic — a 60 cm path on a 10 cm grid — not an accessibility assessment");
  return out;
}

/** "the television, 4 artworks and 2 curtains". */
function counted(objects: readonly SceneObject[]): string[] {
  const groups = new Map<string, number>();
  for (const o of objects) groups.set(o.category, (groups.get(o.category) ?? 0) + 1);
  return [...groups.entries()].map(([category, n]) => {
    const name = category.replace(/-/g, " ");
    return n === 1 ? `the ${name}` : `${n} ${name}s`;
  });
}

const list = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const length = (m: number) => (m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(1)} m`);
const m2 = (a: number) => `${a.toFixed(1)} m²`;
