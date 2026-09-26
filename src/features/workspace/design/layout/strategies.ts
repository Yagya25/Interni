import { findById, roomCentroid, wallFrame } from "@/scene/model/queries";
import type { Id, Scene, SceneObject, Vec2 } from "@/scene/model/types";
import type { Circulation } from "./circulation";
import { footprintOf, halfAlong, hasFront, type Footprint } from "../../ai/rules/spatial";
import { angleOf, frontOf, intrusion, nearestWallOf, PASSAGE, turnBetween, type PassageZone, type Pose } from "./geometry";
import type { LayoutAxis, LayoutStyle } from "./intent";
import type { SpatialRole } from "./roles";

/**
 * What each layout direction asks of each piece.
 * ================================================================
 *
 * A direction is a set of preferences about where pieces stand and which
 * way they face, written against the room's own geometry — the screen's
 * position and facing, the table in front of the main seat, the walls, the
 * doorways. Nothing here names a coordinate. The planner (`planner.ts`)
 * tries each movable piece at every free spot and heading worth trying and
 * keeps the one these preferences favour most, *only* when it is clearly
 * better than leaving the piece where it is.
 *
 * The numbers are internal weights, not a verdict: no layout is scored for
 * the person, and none is called the best.
 */

export interface LayoutContext {
  scene: Scene;
  roles: ReadonlyMap<Id, SpatialRole>;
  primary: SceneObject | null;
  table: SceneObject | null;
  display: SceneObject | null;
  zones: readonly PassageZone[];
  /** Headings squared to the room. */
  squared: readonly number[];
  /** The room's circulation before any layout: what a layout must not take away. */
  circulation: Circulation;
  axes: Readonly<Record<LayoutAxis, number>>;
  /** The least gap a moved piece keeps from any other, metres. */
  gap: number;
}

export interface Goal {
  /** The pieces this direction places, in order. Later ones may be displaced by earlier ones. */
  order: readonly Id[];
  /** Cost per metre moved: how reluctant this direction is to carry things across the room. */
  moveWeight: number;
  /** Headings worth trying for a piece standing at `at`, beyond its own and the squared ones. */
  headings(piece: SceneObject, at: Vec2, working: Scene): number[];
  /** This direction's own cost for a piece at a pose, in the room as placed so far. 0 when it asks nothing of it. */
  cost(piece: SceneObject, pose: Pose, working: Scene): number;
}

export interface ReadingParams {
  /** TV: how strongly the main seat is centred on the screen's axis. */
  centre?: number;
  /** TV: how strongly the other seats are drawn in towards the group. */
  gather?: number;
  /** Conversation: the comfortable distance from a seat to the group's centre. */
  radius?: readonly [number, number];
  /** Conversation: the first chair set across the table from the main seat. */
  faceToFace?: boolean;
  /** Open: how strongly pieces are drawn to the walls. */
  perimeter?: number;
  /** How strongly headings are squared to the room. */
  squared?: number;
  /** Open: only what stands in a doorway's way moves. */
  entranceOnly?: boolean;
}

export interface LayoutReading {
  style: LayoutStyle;
  key: string;
  /** The direction's name, from what this room holds. */
  title(ctx: LayoutContext): string;
  note(ctx: LayoutContext): string;
  params: ReadingParams;
}

const lower = (o: SceneObject | null, fallback: string) => o?.label.toLowerCase() ?? fallback;
const passageName = (ctx: LayoutContext) => ctx.zones[0]?.opening.label.toLowerCase() ?? "way in";

export const READINGS: Readonly<Record<LayoutStyle, readonly LayoutReading[]>> = {
  TV_FOCUSED: [
    { style: "TV_FOCUSED", key: "facing", title: (c) => `Around the ${lower(c.display, "screen")}`, note: (c) => `Seats turned to see the ${lower(c.display, "screen")}; what already sees it stays put.`, params: { centre: 0.1, gather: 0 } },
    { style: "TV_FOCUSED", key: "centred", title: (c) => `Centred on the ${lower(c.display, "screen")}`, note: (c) => `The ${lower(c.primary, "main seat")} and the ${lower(c.table, "table")} brought onto the screen's axis.`, params: { centre: 1.6, gather: 0 } },
    { style: "TV_FOCUSED", key: "gathered", title: (c) => `Gathered at the ${lower(c.display, "screen")}`, note: () => "Every seat drawn in close, all facing the screen.", params: { centre: 0.1, gather: 0.7 } },
  ],
  CONVERSATION: [
    { style: "CONVERSATION", key: "around", title: (c) => (c.table ? `Conversation around the ${lower(c.table, "table")}` : "Conversation group"), note: () => "Seats turned in towards one another, round a shared centre.", params: { radius: [1.0, 1.7], faceToFace: false } },
    { style: "CONVERSATION", key: "close", title: () => "Close conversation", note: () => "The same group, drawn in closer.", params: { radius: [0.75, 1.25], faceToFace: false } },
    { style: "CONVERSATION", key: "face-to-face", title: (c) => (c.table ? `Face to face across the ${lower(c.table, "table")}` : "Face to face"), note: (c) => `A chair set opposite the ${lower(c.primary, "main seat")}.`, params: { radius: [1.0, 1.8], faceToFace: true } },
  ],
  OPEN: [
    { style: "OPEN", key: "open", title: () => "Open floor", note: () => "Pieces drawn back to the walls; the middle of the room left clear.", params: { perimeter: 0.6, squared: 0.15 } },
    { style: "OPEN", key: "path", title: (c) => `Clear way to the ${passageName(c)}`, note: (c) => `Only what stands in front of the ${passageName(c)} moves.`, params: { perimeter: 0, squared: 0, entranceOnly: true } },
    { style: "OPEN", key: "pared-back", title: () => "Pared back to the walls", note: () => "Everything movable set square against a wall.", params: { perimeter: 1.1, squared: 0.5 } },
  ],
};

// ---------------------------------------------------------------------------
// Goals

/** A value read from the room as placed so far, worked out again only when the room changes. */
function perRoom<T>(compute: (working: Scene) => T): (working: Scene) => T {
  let seen: Scene | null = null;
  let value: T;
  return (working) => {
    if (working !== seen) {
      seen = working;
      value = compute(working);
    }
    return value;
  };
}

const face = (err: number) => (1 - Math.cos(err)) / 2;
const at = (pose: Pose): Vec2 => [pose.at[0], pose.at[2]];
const centreOf = (o: SceneObject): Vec2 => [o.transform.position[0], o.transform.position[2]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (v: Vec2) => Math.hypot(v[0], v[1]);
const bearing = (v: Vec2) => Math.atan2(v[0], v[1]);
const isSeatRole = (ctx: LayoutContext, id: Id) => {
  const role = ctx.roles.get(id)?.role;
  return role === "PRIMARY_SEATING" || role === "SECONDARY_SEATING";
};
const movable = (ctx: LayoutContext, id: Id) => ctx.roles.get(id)?.mobility === "movable";
const area = (o: SceneObject) => o.dimensions[0] * o.transform.scale[0] * o.dimensions[2] * o.transform.scale[2];

/** Seats that take part in an arrangement: ones with a front. A pouf is a perch, not a place in the group. */
const groupSeats = (ctx: LayoutContext, scene: Scene) =>
  scene.objects.filter((o) => isSeatRole(ctx, o.id) && hasFront(o) && o.support.kind === "floor");

/** The order pieces are placed in: the main seat, its table, the other seats (largest first), then the rest. */
export function placementOrder(ctx: LayoutContext, pieces: readonly SceneObject[]): Id[] {
  const rank = (o: SceneObject) => {
    const role = ctx.roles.get(o.id)?.role;
    if (role === "PRIMARY_SEATING") return 0;
    if (o.id === ctx.table?.id) return 1;
    if (role === "SECONDARY_SEATING") return hasFront(o) ? 2 : 4;
    if (role === "TABLE") return 3;
    if (role === "LIGHTING") return 5;
    return 6;
  };
  return pieces
    .filter((o) => movable(ctx, o.id))
    .sort((a, b) => rank(a) - rank(b) || area(b) - area(a) || a.id.localeCompare(b.id))
    .map((o) => o.id);
}

/**
 * The table in front of the main seat: straight ahead of it, a comfortable
 * reach from its front, its long side along the seat.
 */
function tableCost(ctx: LayoutContext, table: SceneObject, pose: Pose, working: Scene): number {
  const seat = ctx.primary && findById(working.objects, ctx.primary.id);
  if (!seat) return 0;
  const s = footprintOf(seat);
  const f = footprintOf(table, pose.at, pose.rotationY);
  const front = frontOf(seat.transform.rotation[1]);
  const d = sub(at(pose), centreOf(seat));
  const ahead = d[0] * front[0] + d[1] * front[1];
  const gap = ahead - s.hz - halfAlong(f, front);
  const lateral = Math.abs(d[0] * front[1] - d[1] * front[0]);
  const long = table.dimensions[0] >= table.dimensions[2] ? pose.rotationY : pose.rotationY + Math.PI / 2;
  const across = Math.abs(Math.cos(long - seat.transform.rotation[1]));
  return 1.2 * (Math.max(0, 0.35 - gap) + Math.max(0, gap - 0.5)) + 0.8 * Math.max(0, lateral - 0.05) + 0.4 * (1 - across);
}

/** The strip between the main seat and the screen: tall pieces in it hide the picture. */
function sightline(ctx: LayoutContext, working: Scene): Footprint | null {
  const seat = ctx.primary && findById(working.objects, ctx.primary.id);
  if (!seat || !ctx.display) return null;
  const s = footprintOf(seat);
  const front = frontOf(seat.transform.rotation[1]);
  const a: Vec2 = [s.cx + front[0] * s.hz, s.cz + front[1] * s.hz];
  const b = centreOf(ctx.display);
  const v = sub(b, a);
  const length = len(v);
  if (length < 0.2) return null;
  return { cx: (a[0] + b[0]) / 2, cz: (a[1] + b[1]) / 2, hx: (ctx.display.dimensions[0] * ctx.display.transform.scale[0]) / 2 + 0.1, hz: length / 2, angle: angleOf(v), y0: 0, y1: 3 };
}

/** Where a group of seats gathers: the table in front of the main seat, else a point ahead of it. */
function groupCentre(ctx: LayoutContext, working: Scene, scene: Scene): Vec2 {
  const table = ctx.table && findById(working.objects, ctx.table.id);
  if (table) return centreOf(table);
  const seat = ctx.primary && findById(working.objects, ctx.primary.id);
  if (seat) {
    const f = frontOf(seat.transform.rotation[1]);
    const c = centreOf(seat);
    return [c[0] + f[0] * 1.2, c[1] + f[1] * 1.2];
  }
  return roomCentroid(scene);
}

export function goalFor(ctx: LayoutContext, reading: LayoutReading): Goal {
  const p = reading.params;
  const { axes } = ctx;
  const order = placementOrder(ctx, ctx.scene.objects);
  const common = (piece: SceneObject, pose: Pose, working: Scene) => (piece.id === ctx.table?.id ? tableCost(ctx, piece, pose, working) : 0);
  // Read once per arrangement, not once per candidate pose.
  const stripIn = perRoom((working) => sightline(ctx, working));
  const centreIn = perRoom((working) => groupCentre(ctx, working, ctx.scene));
  const seatsIn = perRoom((working) => groupSeats(ctx, working));

  if (reading.style === "TV_FOCUSED" && ctx.display) {
    const display = ctx.display;
    const d = centreOf(display);
    const n = frontOf(display.transform.rotation[1]);
    const width = display.dimensions[0] * display.transform.scale[0];
    const [near, far] = [Math.max(1.5, 1.2 * width), Math.max(3.8, 3 * width)];
    const centre = (p.centre ?? 0) + 0.4 * Math.max(0, axes.symmetry);
    const gather = (p.gather ?? 0) + 0.5 * Math.max(0, axes.compactness);
    return {
      order,
      moveWeight: 0.5,
      headings: (piece, c) => (hasFront(piece) && isSeatRole(ctx, piece.id) ? [angleOf(sub(d, c))] : []),
      cost: (piece, pose, working) => {
        if (!isSeatRole(ctx, piece.id) || !hasFront(piece)) return common(piece, pose, working);
        const c = at(pose);
        const v = sub(c, d);
        const dist = len(v);
        let cost = 2 * face(turnBetween(pose.rotationY, angleOf(sub(d, c))));
        // Inside the screen's viewing angle, and at a distance it reads from.
        const off = Math.acos(Math.max(-1, Math.min(1, (v[0] * n[0] + v[1] * n[1]) / (dist || 1))));
        cost += 1.2 * Math.min(1.5, Math.max(0, (off - Math.PI / 3) / (Math.PI / 6)));
        cost += 0.6 * (Math.max(0, near - dist) + Math.max(0, dist - far));
        if (piece.id === ctx.primary?.id) {
          cost += centre * Math.abs(v[0] * n[1] - v[1] * n[0]);
        } else {
          const strip = stripIn(working);
          if (strip && piece.dimensions[1] * piece.transform.scale[1] > 0.6) cost += 2.5 * intrusion(footprintOf(piece, pose.at, pose.rotationY), strip);
          if (gather > 0) cost += gather * Math.max(0, len(sub(c, centreIn(working))) - 1.4);
        }
        return cost;
      },
    };
  }

  if (reading.style === "CONVERSATION") {
    const [r0, r1] = p.radius ?? [1.0, 1.7];
    const shrink = 0.25 * Math.max(0, axes.compactness) - 0.3 * Math.max(0, axes.separation);
    const [lo, hi] = [Math.max(0.7, r0 - shrink), Math.max(0.9, r1 - shrink)];
    return {
      order,
      moveWeight: 0.35,
      headings: (piece, c, working) => (hasFront(piece) && isSeatRole(ctx, piece.id) ? [angleOf(sub(centreIn(working), c))] : []),
      cost: (piece, pose, working) => {
        if (!isSeatRole(ctx, piece.id) || !hasFront(piece)) return common(piece, pose, working);
        const centre = centreIn(working);
        const c = at(pose);
        const err = turnBetween(pose.rotationY, angleOf(sub(centre, c)));
        if (piece.id === ctx.primary?.id) return 0.6 * face(err);
        const dist = len(sub(c, centre));
        let cost = 2 * face(err) + 1.0 * (Math.max(0, lo - dist) + Math.max(0, dist - hi));
        // Spread round the centre rather than bunched on one side of it.
        const mine = bearing(sub(c, centre));
        const others = seatsIn(working).filter((o) => o.id !== piece.id && len(sub(centreOf(o), centre)) < hi + 0.8);
        for (const other of others) {
          const gap = turnBetween(mine, bearing(sub(centreOf(other), centre)));
          if (gap < (55 * Math.PI) / 180) cost += 0.9 * (1 - gap / ((55 * Math.PI) / 180));
        }
        const primary = ctx.primary && findById(working.objects, ctx.primary.id);
        if (p.faceToFace && primary && piece.id === firstChair(ctx)) {
          cost += 0.9 * (1 + Math.cos(turnBetween(mine, bearing(sub(centreOf(primary), centre))))) / 2;
        }
        if (axes.symmetry > 0 && primary) cost += axes.symmetry * mirrorCost(piece, c, centre, primary, seatsIn(working));
        // A group need not hide the screen; a little is allowed, as the price of a conversation.
        const strip = stripIn(working);
        if (strip && piece.dimensions[1] * piece.transform.scale[1] > 0.6) cost += 0.4 * intrusion(footprintOf(piece, pose.at, pose.rotationY), strip);
        return cost;
      },
    };
  }

  // OPEN, and a TV direction asked of a room with no screen.
  const perimeter = (p.perimeter ?? 0.6) + 0.3 * Math.max(0, axes.openness - 0.65);
  const square = (p.squared ?? 0) + 0.3 * Math.max(0, axes.symmetry);
  const inWay = (piece: SceneObject) => ctx.zones.some(({ zone }) => intrusion(footprintOf(piece), zone) > 0.1);
  return {
    order: p.entranceOnly ? order.filter((id) => inWay(findById(ctx.scene.objects, id)!)) : order,
    moveWeight: p.entranceOnly ? 0.7 : 0.45,
    headings: () => [],
    cost: (piece, pose, working) => {
      if (piece.id === ctx.table?.id) return tableCost(ctx, piece, pose, working);
      const f = footprintOf(piece, pose.at, pose.rotationY);
      let cost = 0;
      for (const { zone } of ctx.zones) {
        // Half out of a doorway is still in it: standing in the way at all costs a step, then by the depth.
        const depth = intrusion(f, zone);
        cost += 6 * depth + (depth > PASSAGE.tolerance ? 2 : 0);
      }
      const near = nearestWallOf(working, f);
      if (near) cost += perimeter * Math.min(2, Math.max(0, near.gap));
      if (square > 0) cost += square * Math.min(...ctx.squared.map((a) => turnBetween(pose.rotationY, a))) / (Math.PI / 4);
      if (hasFront(piece) && isSeatRole(ctx, piece.id)) {
        // A seat at a wall faces into the room, towards where people gather.
        if (near && near.gap < 0.5) {
          const { inward } = wallFrame(working, near.wall);
          const front = frontOf(pose.rotationY);
          cost += 0.9 * (1 - (front[0] * inward[0] + front[1] * inward[1])) / 2;
        }
        cost += 0.4 * face(turnBetween(pose.rotationY, angleOf(sub(centreIn(working), at(pose)))));
      }
      return cost;
    },
  };
}

/** The largest seat after the main one: the chair a face-to-face reading sets across the table. */
function firstChair(ctx: LayoutContext): Id | null {
  return placementOrder(ctx, ctx.scene.objects).find((id) => ctx.roles.get(id)?.role === "SECONDARY_SEATING" && hasFront(findById(ctx.scene.objects, id)!)) ?? null;
}

/** How far a seat stands from the mirror image, across the main seat's axis, of a seat already placed. */
function mirrorCost(piece: SceneObject, c: Vec2, centre: Vec2, primary: SceneObject, seats: readonly SceneObject[]): number {
  const axis = frontOf(primary.transform.rotation[1]);
  const placed = seats.filter((o) => o.id !== piece.id && o.id !== primary.id);
  let best = Infinity;
  for (const other of placed) {
    const v = sub(centreOf(other), centre);
    const along = v[0] * axis[0] + v[1] * axis[1];
    const mirror: Vec2 = [centre[0] + axis[0] * along - (v[0] - axis[0] * along), centre[1] + axis[1] * along - (v[1] - axis[1] * along)];
    best = Math.min(best, len(sub(c, mirror)));
  }
  return Number.isFinite(best) ? 0.6 * Math.min(1.5, best) : 0;
}
