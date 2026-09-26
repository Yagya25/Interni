import type { Id, Relationship, RelationPredicate } from "@/scene/model/types";
import type { Placed } from "./objects";

/**
 * Spatial relationships, derived by fixed rules from where things were placed.
 * Deterministic: the same placements always give the same list, in the same
 * order, with the same ids. Thresholds are provisional, like every other.
 *
 * Each rule is also exported on its own, so a room that has been edited can
 * be read by the very same rules the compiler used on the photograph — a
 * layout proposal asks "is the table still in front of the sofa?" of these
 * functions rather than of a second copy of them.
 */
export const RELATION_RULES = {
  version: "relations-0.1",
  /** in-front-of: within this distance, and this close to straight ahead. */
  inFrontDistance: 2.2,
  inFrontAngleDeg: 35,
  /** faces: looking at something no further than this, passing within its reach plus this margin. */
  facesDistance: 7,
  facesMargin: 0.3,
  /** beside: gap between footprints below this, and more to the side than ahead. */
  besideGap: 0.6,
} as const;

/** What the rules read of a placed piece. */
export type RelationInput = Pick<Placed, "object" | "front" | "against" | "onWall">;

const TABLES = new Set(["coffee-table", "side-table", "ottoman"]);
const LOOKERS = new Set(["television", "sofa", "armchair", "chair", "lounge-chair"]);
const ORDER: readonly RelationPredicate[] = ["on", "against", "above", "in-front-of", "faces", "beside"];

const radius = (p: RelationInput) => Math.hypot(p.object.dimensions[0], p.object.dimensions[2]) / 2;
const xz = (p: RelationInput) => [p.object.transform.position[0], p.object.transform.position[2]] as const;

export const isLooker = (p: RelationInput) => LOOKERS.has(p.object.category);

/** A picture or a wall-hung TV above a piece standing beneath it on the same wall. */
export function isAbove(w: RelationInput, f: RelationInput): boolean {
  if (!w.onWall || f.onWall || f.object.support.kind !== "floor" || f.against !== w.onWall) return false;
  const [wx, wz] = xz(w);
  const [fx, fz] = xz(f);
  const along = Math.abs((wx - fx) * f.front[1] - (wz - fz) * f.front[0]);
  return along < f.object.dimensions[0] / 2 && w.object.transform.position[1] > f.object.dimensions[1];
}

/** A table in front of a seat. */
export function isInFrontOf(table: RelationInput, seat: RelationInput): boolean {
  if (!isLooker(seat) || seat.onWall || !TABLES.has(table.object.category)) return false;
  const [sx, sz] = xz(seat);
  const [tx, tz] = xz(table);
  const d = Math.hypot(tx - sx, tz - sz);
  if (d === 0 || d > RELATION_RULES.inFrontDistance) return false;
  const cos = ((tx - sx) * seat.front[0] + (tz - sz) * seat.front[1]) / d;
  return cos > Math.cos((RELATION_RULES.inFrontAngleDeg * Math.PI) / 180);
}

/**
 * What a TV or a seat looks at: of the lookers its front ray passes over,
 * the one it faces most squarely (off-axis distance relative to its size).
 */
export function facedBy(a: RelationInput, placed: readonly RelationInput[]): RelationInput | null {
  if (!isLooker(a)) return null;
  const [ax, az] = xz(a);
  const target = placed
    .filter((b) => b !== a && b.object.id !== a.object.id && isLooker(b))
    .map((b) => {
      const [bx, bz] = xz(b);
      const ahead = (bx - ax) * a.front[0] + (bz - az) * a.front[1];
      const off = Math.abs((bx - ax) * a.front[1] - (bz - az) * a.front[0]);
      return { b, ahead, off };
    })
    .filter(({ b, ahead, off }) => ahead > 0.5 && ahead < RELATION_RULES.facesDistance && off < radius(b) + RELATION_RULES.facesMargin)
    .sort((x, y) => x.off / radius(x.b) - y.off / radius(y.b) || x.ahead - y.ahead)[0];
  return target?.b ?? null;
}

/** Two pieces on the floor side by side: the smaller (`b`) is beside the larger (`a`). */
export function isBeside(b: RelationInput, a: RelationInput): boolean {
  if (a === b || a.object.id === b.object.id) return false;
  if (a.object.support.kind !== "floor" || a.onWall || b.object.support.kind !== "floor" || b.onWall || radius(b) > radius(a)) return false;
  if (radius(b) === radius(a) && b.object.id < a.object.id) return false;
  const [ax, az] = xz(a);
  const [bx, bz] = xz(b);
  const d = Math.hypot(bx - ax, bz - az);
  const gap = d - radius(a) - radius(b);
  const ahead = d > 0 ? Math.abs(((bx - ax) * a.front[0] + (bz - az) * a.front[1]) / d) : 1;
  return gap < RELATION_RULES.besideGap && ahead < 0.5;
}

export function deriveRelationships(placed: readonly RelationInput[]): Relationship[] {
  const found: { subjectId: Id; predicate: RelationPredicate; objectId: Id }[] = [];
  const add = (subjectId: Id, predicate: RelationPredicate, objectId: Id) => {
    if (subjectId === objectId) return;
    if (found.some((r) => r.subjectId === subjectId && r.objectId === objectId)) return;
    found.push({ subjectId, predicate, objectId });
  };

  for (const p of placed) {
    if (p.object.support.kind === "object") add(p.object.id, "on", p.object.support.objectId);
  }
  for (const p of placed) {
    if (p.against && p.object.support.kind === "floor") add(p.object.id, "against", p.against);
  }
  for (const w of placed) {
    for (const f of placed) if (isAbove(w, f)) add(w.object.id, "above", f.object.id);
  }
  for (const seat of placed) {
    for (const t of placed) if (isInFrontOf(t, seat)) add(t.object.id, "in-front-of", seat.object.id);
  }
  for (const a of placed) {
    const target = facedBy(a, placed);
    if (target) add(a.object.id, "faces", target.object.id);
  }
  for (const a of placed) {
    for (const b of placed) if (isBeside(b, a)) add(b.object.id, "beside", a.object.id);
  }

  found.sort(
    (x, y) =>
      ORDER.indexOf(x.predicate) - ORDER.indexOf(y.predicate) ||
      x.subjectId.localeCompare(y.subjectId) ||
      x.objectId.localeCompare(y.objectId),
  );
  return found.map((r, i) => ({ id: `rel-${i}`, ...r }));
}
