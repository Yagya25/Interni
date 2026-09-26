import type { Scene } from "@/scene/model/types";
import type { LayoutAnalysis } from "./analysis";
import { layoutAxes, LAYOUT_STYLES, type LayoutAxis, type LayoutIntent, type LayoutStyle } from "./intent";
import { contextOf, planLayout, type LayoutPlan } from "./planner";
import { describeLayout, type LayoutReport } from "./report";
import { READINGS, type LayoutContext, type LayoutReading } from "./strategies";

/**
 * From a layout intent to layouts.
 * ================================================================
 *
 * Which directions to build, in what order, then each one planned against
 * the room. A direction that would move nothing, or would arrange the room
 * exactly as one already offered does, is left out with its reason: three
 * layouts are three different arrangements, or fewer than three.
 */

/** What each direction sets out to do, for the card. */
export const LAYOUT_GOALS: Readonly<Record<LayoutStyle, readonly string[]>> = {
  TV_FOCUSED: ["Seats face the screen", "The line from the main seat to the screen kept clear", "Only what needs to move, moves"],
  CONVERSATION: ["Seats turned towards one another", "A comfortable distance across the table", "Room to sit down and to get past"],
  OPEN: ["The middle of the floor left clear", "The way in kept clear", "Seats at the walls face into the room"],
};

export interface PlannedLayout {
  id: string;
  title: string;
  note: string;
  goals: readonly string[];
  reading: LayoutReading;
  plan: LayoutPlan;
  report: LayoutReport;
}

export interface LayoutResult {
  layouts: readonly PlannedLayout[];
  rejected: readonly { id: string; title: string; reason: string }[];
}

export function planLayouts(scene: Scene, analysis: LayoutAnalysis, intent: LayoutIntent, count: number): LayoutResult {
  const axes = layoutAxes(intent);
  const ctx = contextOf(scene, analysis, axes);
  const layouts: PlannedLayout[] = [];
  const rejected: { id: string; title: string; reason: string }[] = [];
  const seen = new Map<string, string>();

  for (const reading of readingsFor(ctx, intent, axes, count, rejected)) {
    if (layouts.length === count) break;
    const id = `layout-${reading.style.toLowerCase().replace(/_/g, "-")}-${reading.key}`;
    const title = reading.title(ctx);
    const planned = planLayout(ctx, reading);
    if (!planned.ok) {
      rejected.push({ id, title, reason: planned.reason });
      continue;
    }
    const signature = JSON.stringify(planned.plan.operations);
    const same = seen.get(signature);
    if (same) {
      rejected.push({ id, title, reason: `it would arrange the room exactly as “${same}” does` });
      continue;
    }
    seen.set(signature, title);
    layouts.push({ id, title, note: reading.note(ctx), goals: LAYOUT_GOALS[reading.style], reading, plan: planned.plan, report: describeLayout(ctx, reading, planned.plan) });
  }
  // Readings that were tried and gave way to another are alternatives, not directions the person
  // asked for: they are only worth saying when fewer layouts could be offered than were asked for.
  return { layouts, rejected: layouts.length < count ? rejected : [] };
}

/**
 * The readings to try, in order. Directions named in the request come
 * first; otherwise the one the request's axes point at, with all three of
 * its readings when more than one layout is asked for; and when the request
 * says nothing at all about how, one reading of each direction. A screen
 * direction is not offered to a room without a screen.
 *
 * More readings are returned than asked for, so a reading that proves the
 * same as another, or impossible here, can give way to the next.
 */
function readingsFor(ctx: LayoutContext, intent: LayoutIntent, axes: Readonly<Record<LayoutAxis, number>>, count: number, rejected: { id: string; title: string; reason: string }[]): LayoutReading[] {
  const possible = (style: LayoutStyle) => style !== "TV_FOCUSED" || ctx.display !== null;
  for (const style of intent.styles) {
    if (!possible(style)) rejected.push({ id: "layout-tv-focused", title: "Around the screen", reason: "this room has no television or screen to arrange it around" });
  }
  const scored: [LayoutStyle, number][] = LAYOUT_STYLES.map((style) => [
    style,
    style === "TV_FOCUSED" ? axes.tvFocus : style === "CONVERSATION" ? axes.social + 0.5 * axes.compactness : axes.openness + axes.circulation - 0.5 * axes.compactness,
  ]);
  const leaning = scored.filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([style]) => style);
  const named = intent.styles.filter(possible);
  // Asked for by name, or leant towards, and impossible here: said so, not swapped for something else.
  if (intent.styles.length > 0 && named.length === 0) return [];
  if (intent.styles.length === 0 && leaning.length > 0 && leaning.every((style) => !possible(style))) {
    rejected.push({ id: "layout-tv-focused", title: "Around the screen", reason: "this room has no television or screen to arrange it around" });
    return [];
  }
  const asked = named.length > 0 ? named : leaning.filter(possible);

  const order = (style: LayoutStyle) => ordered(READINGS[style], axes);
  if (asked.length === 0) {
    // Nothing said about how: one of each direction, then the rest of their readings.
    const spread = LAYOUT_STYLES.filter(possible);
    return [...spread.map((s) => order(s)[0]), ...spread.flatMap((s) => order(s).slice(1))];
  }
  if (count === 1 || asked.length === 1) return [...asked.flatMap((s) => order(s))];
  // Several asked: one reading of each before a second of any.
  const out: LayoutReading[] = [];
  for (let i = 0; i < 3; i++) for (const style of asked) out.push(order(style)[i]);
  return out;
}

/** A direction's readings, the one the request's axes favour first. */
function ordered(readings: readonly LayoutReading[], axes: Readonly<Record<LayoutAxis, number>>): LayoutReading[] {
  const first = (key: string) => [...readings.filter((r) => r.key === key), ...readings.filter((r) => r.key !== key)];
  const style = readings[0].style;
  if (style === "TV_FOCUSED") return axes.compactness > 0 ? first("gathered") : axes.symmetry > 0 ? first("centred") : [...readings];
  if (style === "CONVERSATION") return axes.compactness > 0 ? first("close") : axes.symmetry > 0 ? first("face-to-face") : [...readings];
  return axes.symmetry > 0 ? first("pared-back") : axes.circulation > 0 && axes.openness <= 0 ? first("path") : [...readings];
}
