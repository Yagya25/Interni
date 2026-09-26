import { openingCenter, walls, wallFrame } from "@/scene/model/queries";
import type { Id, Opening } from "@/scene/model/types";
import { obstaclesOf } from "../design/layout/circulation";
import { intrusion, isPassage, PASSAGE, passageZones } from "../design/layout/geometry";
import { clearDepth, polygonOf } from "./geometry";
import { boundaryOf, endInputs, type EndedBy } from "./objects";
import { footprintInputs, openingInput, wallInput, withScale, type Knowledge } from "./provenance";
import { measurement, unavailable, type Measured } from "./types";

/**
 * Doors and windows, and the floor in front of a doorway.
 * ================================================================
 *
 * An opening's own width, height and sill are read straight from the Scene
 * with the evidence the compiler recorded for them. An opening a person can
 * walk through — the layout heuristic's `isPassage`: bottom at the floor, at
 * least 1.8 m tall, whatever the detector named it — also gets the depth of
 * clear floor straight in from it across its full width, and what ends it,
 * and the pieces that stand into its clear zone.
 */

export interface OpeningMeasurements {
  id: Id;
  label: string;
  kind: Opening["kind"];
  wallId: Id;
  /** A person can walk through it. */
  passage: boolean;
  width: Measured;
  height: Measured;
  sill: Measured;
  /** Clear floor straight in from a doorway, across its full width, and what ends it. */
  clearDepth: { depth: Measured; endedBy: EndedBy } | null;
  /** Pieces standing into the doorway's clear zone (the layout heuristic's, 0.9 m deep), and how far in. */
  intrusions: readonly { id: Id; label: string; depth: Measured }[];
}

export function measureOpenings(k: Knowledge): OpeningMeasurements[] {
  const obstacles = obstaclesOf(k.scene);
  const zones = passageZones(k.scene);
  return k.scene.openings.map((opening) => {
    const own = (field: "width" | "height" | "sill") => {
      const value = opening[field];
      const valid = Number.isFinite(value) && (field === "sill" ? value >= 0 : value > 0);
      return valid ? measurement(value, "m", [opening.id], withScale(k, [openingInput(k, opening, field)]), { direct: true }) : unavailable(`its ${field} in the Scene is not a usable length`);
    };
    const base = { id: opening.id, label: opening.label, kind: opening.kind, wallId: opening.wallId, passage: isPassage(opening), width: own("width"), height: own("height"), sill: own("sill") };
    const wall = walls(k.scene).find((w) => w.id === opening.wallId);
    if (!base.passage || !wall || !(opening.width > 0)) return { ...base, clearDepth: null, intrusions: [] };

    const { inward } = wallFrame(k.scene, wall);
    const c = openingCenter(k.scene, opening);
    const blockers = [
      ...obstacles.map(({ object, footprint }) => ({ what: { kind: "object" as const, id: object.id, label: object.label }, shape: polygonOf(footprint) })),
      // The wall the doorway is in does not stand in front of it.
      ...boundaryOf(k.scene).filter((b) => b.endedBy.id !== opening.wallId).map((b) => ({ what: b.endedBy, shape: b.segment })),
    ];
    const clear = clearDepth({ origin: [c[0], c[2]], forward: inward, half: opening.width / 2 }, blockers);
    const doorway = [openingInput(k, opening, "width"), wallInput(k, wall)];
    const zone = zones.find((z) => z.opening.id === opening.id)?.zone;
    return {
      ...base,
      clearDepth: clear
        ? { depth: measurement(clear.depth, "m", [opening.id, ...(clear.by.id ? [clear.by.id] : [])], withScale(k, [...doorway, ...endInputs(k, clear.by)]), { rule: "clear-depth" }), endedBy: clear.by }
        : { depth: unavailable("nothing ends the floor in front of it: the room is not closed"), endedBy: { kind: "edge" as const, id: null, label: "nothing" } },
      intrusions: zone
        ? obstacles
            .map(({ object, footprint }) => ({ object, depth: intrusion(footprint, zone) }))
            .filter(({ depth }) => depth > 0)
            .map(({ object, depth }) => ({
              id: object.id,
              label: object.label,
              depth: measurement(depth, "m", [opening.id, object.id], withScale(k, [...doorway, ...footprintInputs(k, object)]), {
                rule: "doorway-zone",
                note: `how far it stands into the ${PASSAGE.depth} m clear zone in front of the doorway; the layouts count more than ${Math.round(PASSAGE.tolerance * 100)} cm as in the way`,
              }),
            }))
        : [],
    };
  });
}
