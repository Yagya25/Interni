import type { Id, Relationship, RelationPredicate } from "@/scene/model/types";
import type { Placed } from "./objects";

/**
 * Spatial relationships, derived by fixed rules from where things were placed.
 * Deterministic: the same placements always give the same list, in the same
 * order, with the same ids. Thresholds are provisional, like every other.
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

const TABLES = new Set(["coffee-table", "side-table", "ottoman"]);
const LOOKERS = new Set(["television", "sofa", "armchair", "chair", "lounge-chair"]);
const ORDER: readonly RelationPredicate[] = ["on", "against", "above", "in-front-of", "faces", "beside"];

export function deriveRelationships(placed: readonly Placed[]): Relationship[] {
  const found: { subjectId: Id; predicate: RelationPredicate; objectId: Id }[] = [];
  const add = (subjectId: Id, predicate: RelationPredicate, objectId: Id) => {
    if (subjectId === objectId) return;
    if (found.some((r) => r.subjectId === subjectId && r.objectId === objectId)) return;
    found.push({ subjectId, predicate, objectId });
  };
  const radius = (p: Placed) => Math.hypot(p.object.dimensions[0], p.object.dimensions[2]) / 2;
  const xz = (p: Placed) => [p.object.transform.position[0], p.object.transform.position[2]] as const;

  for (const p of placed) {
    if (p.object.support.kind === "object") add(p.object.id, "on", p.object.support.objectId);
  }
  for (const p of placed) {
    if (p.against && p.object.support.kind === "floor") add(p.object.id, "against", p.against);
  }
  // A picture or a wall-hung TV above a piece standing beneath it on the same wall.
  for (const w of placed) {
    if (!w.onWall) continue;
    for (const f of placed) {
      if (f.onWall || f.object.support.kind !== "floor" || f.against !== w.onWall) continue;
      const [wx, wz] = xz(w);
      const [fx, fz] = xz(f);
      const along = Math.abs((wx - fx) * f.front[1] - (wz - fz) * f.front[0]);
      if (along < f.object.dimensions[0] / 2 && w.object.transform.position[1] > f.object.dimensions[1]) {
        add(w.object.id, "above", f.object.id);
      }
    }
  }
  // A table in front of a seat.
  for (const seat of placed) {
    if (!LOOKERS.has(seat.object.category) || seat.onWall) continue;
    for (const t of placed) {
      if (!TABLES.has(t.object.category)) continue;
      const [sx, sz] = xz(seat);
      const [tx, tz] = xz(t);
      const d = Math.hypot(tx - sx, tz - sz);
      if (d === 0 || d > RELATION_RULES.inFrontDistance) continue;
      const cos = ((tx - sx) * seat.front[0] + (tz - sz) * seat.front[1]) / d;
      if (cos > Math.cos((RELATION_RULES.inFrontAngleDeg * Math.PI) / 180)) add(t.object.id, "in-front-of", seat.object.id);
    }
  }
  // What a TV or a seat looks at: of the lookers its front ray passes over,
  // the one it faces most squarely (off-axis distance relative to its size).
  for (const a of placed) {
    if (!LOOKERS.has(a.object.category)) continue;
    const [ax, az] = xz(a);
    const target = placed
      .filter((b) => b !== a && LOOKERS.has(b.object.category))
      .map((b) => {
        const [bx, bz] = xz(b);
        const ahead = (bx - ax) * a.front[0] + (bz - az) * a.front[1];
        const off = Math.abs((bx - ax) * a.front[1] - (bz - az) * a.front[0]);
        return { b, ahead, off };
      })
      .filter(({ b, ahead, off }) => ahead > 0.5 && ahead < RELATION_RULES.facesDistance && off < radius(b) + RELATION_RULES.facesMargin)
      .sort((x, y) => x.off / radius(x.b) - y.off / radius(y.b) || x.ahead - y.ahead)[0];
    if (target) add(a.object.id, "faces", target.b.object.id);
  }
  // Two pieces on the floor side by side: the smaller is beside the larger.
  for (const a of placed) {
    if (a.object.support.kind !== "floor" || a.onWall) continue;
    for (const b of placed) {
      if (b === a || b.object.support.kind !== "floor" || b.onWall || radius(b) > radius(a)) continue;
      if (radius(b) === radius(a) && b.object.id < a.object.id) continue;
      const [ax, az] = xz(a);
      const [bx, bz] = xz(b);
      const d = Math.hypot(bx - ax, bz - az);
      const gap = d - radius(a) - radius(b);
      const ahead = d > 0 ? Math.abs(((bx - ax) * a.front[0] + (bz - az) * a.front[1]) / d) : 1;
      if (gap < RELATION_RULES.besideGap && ahead < 0.5) add(b.object.id, "beside", a.object.id);
    }
  }

  found.sort(
    (x, y) =>
      ORDER.indexOf(x.predicate) - ORDER.indexOf(y.predicate) ||
      x.subjectId.localeCompare(y.subjectId) ||
      x.objectId.localeCompare(y.objectId),
  );
  return found.map((r, i) => ({ id: `rel-${i}`, ...r }));
}
