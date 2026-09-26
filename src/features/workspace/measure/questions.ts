import type { SceneEvidence } from "@/scene/compile/evidence";
import { findById } from "@/scene/model/queries";
import type { Id, Scene } from "@/scene/model/types";
import { hasFront } from "../ai/rules/spatial";
import { CIRCULATION } from "../design/layout/circulation";
import { isSeat } from "../design/layout/roles";
import { distanceBetween } from "./distance";
import { basisOf, formatMeasurement } from "./format";
import { measureScene, measureWalkway } from "./scene";
import { clearAround, type EndedBy } from "./objects";
import { knowledgeOf } from "./provenance";
import { atLeast, type Measured, type Measurement, type Verdict } from "./types";
import type { Walkway } from "./walkways";

/**
 * Spatial questions, answered from the measurements.
 * ================================================================
 *
 * A typed question in, a typed answer out: the measurements it rests on, a
 * verdict where the question asks for one, and one plain sentence that
 * says what was measured and how it is known. There is no language model
 * and no chat here — reading a person's words into a question is a later,
 * separate step — and nothing is answered that the measurements do not
 * support: what cannot be measured says why.
 */

export type SpatialQuestion =
  /** "How wide is the room?" */
  | { kind: "room-size" }
  /** "What is the sofa's approximate size?" */
  | { kind: "object-size"; objectId: Id }
  /** "How much space is between the sofa and the coffee table?" */
  | { kind: "distance"; from: Id; to: Id }
  /** "How much clearance is there around this chair?" */
  | { kind: "clearance"; objectId: Id }
  /** "How much floor is free?" — floor not under any standing piece. */
  | { kind: "free-floor" }
  /** "How much walkable floor is there?" — the circulation heuristic's path area. */
  | { kind: "circulation-area" }
  /** "How wide is the way to the sofa?" */
  | { kind: "walkway"; objectId: Id }
  /** "Is there at least 80 cm of circulation space?" — on the way from a doorway to every seat. */
  | { kind: "circulation-at-least"; metres: number };

export type SpatialAnswer =
  | { ok: true; question: SpatialQuestion; text: string; measurements: readonly Measurement[]; verdict?: Verdict }
  | { ok: false; question: SpatialQuestion; reason: string };

export function answer(scene: Scene, evidence: SceneEvidence | null | undefined, question: SpatialQuestion): SpatialAnswer {
  const k = knowledgeOf(scene, evidence);
  const m = measureScene(scene, k.evidence);
  const no = (reason: string): SpatialAnswer => ({ ok: false, question, reason });
  const yes = (text: string, measurements: readonly Measured[], verdict?: Verdict): SpatialAnswer => ({
    ok: true,
    question,
    text,
    measurements: measurements.filter((x): x is Measurement => x.available),
    ...(verdict ? { verdict } : {}),
  });
  const named = (id: Id) => findById(scene.objects, id)?.label ?? findById(scene.openings, id)?.label ?? scene.surfaces.find((s) => s.id === id)?.label ?? id;
  const scaleNote = m.scale?.basis === "estimated" ? " Not calibrated: every length shares one unknown scale error." : m.source === "authored" ? " This room was authored, not measured." : "";

  switch (question.kind) {
    case "room-size": {
      const { width, depth, height, floorArea } = m.room;
      if (!width.available || !depth.available) return no(!width.available ? width.reason : (depth as { reason: string }).reason);
      return yes(
        `The room is ${formatMeasurement(width)} across (${basisOf(width)}), ${formatMeasurement(depth)} along (${basisOf(depth)}) and ${formatMeasurement(height)} high (${basisOf(height)}); its floor is ${formatMeasurement(floorArea)} (${basisOf(floorArea)}).${scaleNote}`,
        [width, depth, height, floorArea],
      );
    }

    case "object-size": {
      const piece = m.objects.find((o) => o.id === question.objectId);
      if (!piece) return no(`there is nothing called ${question.objectId} in the room`);
      const { width, depth, height } = piece.size;
      if (!width.available) return no(width.reason);
      const bases = [...new Set([width, depth, height].map(basisOf))].join(", ");
      return yes(`${piece.label} is ${formatMeasurement(width)} wide, ${formatMeasurement(depth)} deep and ${formatMeasurement(height)} high (${bases}).${boundNote([width, depth, height])}${scaleNote}`, [width, depth, height]);
    }

    case "distance": {
      const d = distanceBetween(k, question.from, question.to);
      if (!d.available) return no(d.reason);
      const pair = `${named(question.from)} and ${named(question.to)}`;
      return yes(d.rounded === 0 ? `${pair} touch or overlap in plan (${basisOf(d)}).` : `${pair} are ${formatMeasurement(d)} apart in plan (${basisOf(d)}).${scaleNote}`, [d]);
    }

    case "clearance": {
      const object = findById(scene.objects, question.objectId);
      if (!object) return no(`there is nothing called ${question.objectId} in the room`);
      const around = clearAround(k, object);
      if (!around) return no(`${object.label} does not stand on the floor, so there is no floor around it to measure`);
      const side = (s: { depth: Measured; endedBy: EndedBy }) => (s.depth.available && s.depth.rounded === 0 ? `against ${to(s.endedBy)}` : `${formatMeasurement(s.depth)} to ${to(s.endedBy)}`);
      const all = [around.front, around.back, around["side-a"], around["side-b"]];
      const bases = [...new Set(all.map((s) => basisOf(s.depth)))].join(", ");
      const text = hasFront(object)
        ? `Around ${object.label}: in front ${side(around.front)}; behind ${side(around.back)}; at its sides ${side(around["side-a"])} and ${side(around["side-b"])} (${bases}).`
        : `Around ${object.label}, on its four sides: ${all.map(side).join("; ")} (${bases}).`;
      return yes(text + scaleNote, all.map((s) => s.depth));
    }

    case "free-floor": {
      const { free, area, circulation } = m.floor;
      if (!free.available) return no(free.reason);
      return yes(
        `Free floor — not under any standing piece — is ${formatMeasurement(free)} of the room's ${formatMeasurement(area)} (${basisOf(free)}). It is not the circulation area (${formatMeasurement(circulation)}), which counts only where a ${pathWidth()} path can run.${scaleNote}`,
        [free, area],
      );
    }

    case "circulation-area": {
      const { circulation, free } = m.floor;
      if (!circulation.available) return no(circulation.reason);
      const from = m.floor.circulationFrom === "passage" ? "a doorway" : "the largest open region, since the room has no doorway";
      return yes(
        `Circulation area is ${formatMeasurement(circulation)} (${basisOf(circulation)}): the floor where the centre of a ${pathWidth()} path can be, reached from ${from} — the layout heuristic ${CIRCULATION.version}, on a ${Math.round(CIRCULATION.cell * 100)} cm grid. Free floor, not under any piece, is ${formatMeasurement(free)}.${scaleNote}`,
        [circulation],
      );
    }

    case "walkway": {
      const object = findById(scene.objects, question.objectId);
      if (!object) return no(`there is nothing called ${question.objectId} in the room`);
      const way = measureWalkway(scene, k.evidence, object.id);
      if (!way.reachable) return no(`${object.label}: ${way.reason}`);
      const text = describeWay(way, object.label, named);
      return yes(text.charAt(0).toUpperCase() + text.slice(1) + scaleNote, [way.width]);
    }

    case "circulation-at-least": {
      const t = question.metres;
      if (!(Number.isFinite(t) && t > 0)) return no("the width asked for is not a positive length");
      const seats = m.objects.filter((o) => {
        const object = findById(scene.objects, o.id)!;
        return isSeat(object) && object.support.kind === "floor" && o.footprint;
      });
      if (!seats.length) return no("there is no seat standing on the floor to walk to");
      const ways = seats.map((s) => ({ label: s.label, way: measureWalkway(scene, k.evidence, s.id) }));
      const shut = ways.find((w) => !w.way.reachable);
      if (shut && !shut.way.reachable) {
        if (shut.way.reason.includes("no doorway")) return no(shut.way.reason);
        return yes(`No: ${shut.label} cannot be reached from a doorway at all — ${shut.way.reason}.`, [], "no");
      }
      const open = ways.flatMap((w) => (w.way.reachable && w.way.width.available ? [{ label: w.label, way: w.way, width: w.way.width }] : []));
      if (!open.length) return no("no way to a seat could be measured");
      const narrowest = open.reduce((a, b) => (b.width.value < a.width.value ? b : a));
      const verdict = atLeast(narrowest.width, t);
      const tcm = `${Math.round(t * 100)} cm`;
      const way = wayParts(narrowest.way, named);
      const below = open.filter((o) => atLeast(o.width, t) === "no").length;
      const text =
        verdict === "yes"
          ? `Yes: the way from ${way.door} to every seat is at least ${tcm} wide at its narrowest. The tightest is to ${narrowest.label}: ${way.width}, ${way.where} (${way.basis}).`
          : verdict === "no"
            ? `No: the way from ${way.door} to ${narrowest.label} narrows to ${way.width}, ${way.where} (${way.basis}) — below ${tcm}.${below > 1 ? ` The ways to ${below} of the ${open.length} seats are narrower than ${tcm}.` : ""}`
            : `Too close to call against ${tcm}: the way from ${way.door} to ${narrowest.label} narrows to ${way.width}, ${way.where} (${way.basis}), and is known only to ${Math.round(narrowest.width.resolution * 100)} cm.`;
      return yes(text + scaleNote, open.map((o) => o.width), verdict);
    }
  }
}

function wayParts(way: Extract<Walkway, { reachable: true }>, named: (id: Id) => string) {
  const where = way.atDoorway && way.between.length === 1 ? "at the doorway itself" : way.between.length === 2 ? `between ${to(way.between[0])} and ${to(way.between[1])}` : `beside ${to(way.between[0])}`;
  return { door: named(way.from), width: formatMeasurement(way.width), where, basis: basisOf(way.width) };
}

function describeWay(way: Extract<Walkway, { reachable: true }>, label: string, named: (id: Id) => string): string {
  const w = wayParts(way, named);
  return `the way from ${w.door} to ${label} is ${w.width} wide at its narrowest, ${w.where} (${w.basis}).`;
}

const to = (end: EndedBy) => (end.kind === "edge" ? end.label : end.kind === "wall" ? `the ${end.label.charAt(0).toLowerCase()}${end.label.slice(1)}` : end.label);

const pathWidth = () => `${Math.round(CIRCULATION.clearance * 200)} cm`;

function boundNote(ms: readonly Measured[]): string {
  const names = ["width", "depth", "height"];
  const lower = ms.flatMap((m, i) => (m.available && m.bound === "at-least" ? [names[i]] : []));
  const typical = ms.flatMap((m, i) => (m.available && m.bound === "typical" ? [names[i]] : []));
  const parts = [
    lower.length ? `Its ${list(lower)} ${lower.length > 1 ? "are" : "is"} at least this: only part of it was seen.` : "",
    typical.length ? `Its ${list(typical)} ${typical.length > 1 ? "are" : "is"} typical for its kind: the photo could not measure ${typical.length > 1 ? "them" : "it"}.` : "",
  ].filter(Boolean);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

const list = (words: readonly string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0]);
