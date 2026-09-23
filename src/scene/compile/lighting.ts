import type { AmbientLight, ArtificialLight, DaylightSource, Hex, Id, Opening, Vec3, WallSurface } from "@/scene/model/types";
import type { EntityEvidence } from "./evidence";
import { DEG, round } from "./frame";
import type { Basis, LightObservation, Problem, Quantity, ReconstructionIntermediate } from "./intermediate";
import type { Placed } from "./objects";

/**
 * The room's light, from the photograph
 * =====================================
 * The Scene's light contract holds an ambient term, daylight through the
 * openings, and one artificial light per lamp. What the photograph says
 * about each, and what is done with it:
 *
 * - ambient: neutral. The surfaces keep their apparent colours, and each of
 *   those is already the surface times the light that reached it, so the
 *   light's colour is in them. Its measured colour (the interior's grey-world
 *   mean, and its temperature) is recorded beside it, not applied twice;
 * - daylight: through every glazed opening found. `direct` is false when no
 *   sunlit patch was seen on the floor or walls: the daylight is diffuse,
 *   and the renderer's sun is kept out. The hour is not recoverable from a
 *   photograph and stays the renderer's default, said to be so;
 * - lamps: `on` only when the shade is seen lit (much brighter than what
 *   surrounds it, or clipped); an unlit lamp is left to follow the daylight,
 *   with its state recorded as seen;
 * - direction: which way the light comes from, from shading on the pieces,
 *   has no place in the Scene (the openings place the light); it is checked
 *   against the openings and reported, and a direction no opening explains
 *   is a problem, not an invented light.
 */

export const LIGHT_RULES = {
  version: "light-rules-0.1",
  /** A shade this much brighter than its surroundings is lit. */
  lampLitToSurround: 1.6,
  /** Or this share of the shade clipped white. */
  lampLitClipped: 0.05,
  /** Sunlit patches on at least this share of the floor and walls: direct sun. */
  sunPatchFraction: 0.01,
  /** The shading direction is trusted when the pieces agree this much (resultant length) and there are this many. */
  directionAgreement: 0.6,
  directionMinRegions: 3,
  /** An opening explains the direction if its bearing from the room's centre is within this. */
  openingBearingDeg: 60,
  /** The wall-and-ceiling brightness gradient is used when at least this steep and this well fitted. */
  gradientMinPerMetre: 0.1,
  gradientMaxRmse: 0.3,
} as const;

export interface LightingReport {
  rulesVersion: string;
  observed: boolean;
  /** `hex` is the light's colour as measured; `applied` is what the Scene's ambient light carries. */
  colour: { source: "grey-world" | "default"; hex: Hex; applied: Hex; cctK: number | null; ceilingCctK: number | null };
  direction: {
    towardsLight: Vec3;
    elevationDeg: number;
    agreement: number;
    regions: number;
    trusted: boolean;
    nearestOpening: { id: Id; bearingOffDeg: number } | null;
  } | null;
  gradient: { status: "used" | "inconclusive" | "absent"; towardsBrighter: Vec3 | null; perMetre: number | null; rmseLog: number | null; reason: string };
  daylight: { openings: readonly { id: Id; instance: string; toInterior: number | null; clippedFraction: number | null; cctK: number | null }[]; direct: boolean | null; sunPatchFraction: number | null };
  lamps: readonly { lightId: Id; fixtureId: Id; state: "lit" | "unlit" | "not-assessed"; toSurround: number | null }[];
  exposure: LightObservation["exposure"] | null;
}

export interface LightsResult {
  lights: (AmbientLight | DaylightSource | ArtificialLight)[];
  entities: Record<Id, EntityEvidence>;
  report: LightingReport;
  problems: Problem[];
}

interface Frame {
  dirToScene: (v: Vec3) => Vec3;
  walls: readonly WallSurface[];
  bounds: { xMin: number; xMax: number; zMin: number; zMax: number; height: number };
}

export function compileLights(
  input: ReconstructionIntermediate,
  shell: Frame,
  openings: readonly { opening: Opening; instance: string }[],
  placed: readonly Placed[],
): LightsResult {
  const obs = input.world.light;
  const entities: Record<Id, EntityEvidence> = {};
  const problems: Problem[] = [];
  const lights: (AmbientLight | DaylightSource | ArtificialLight)[] = [];
  const rules = "light-rules:" + LIGHT_RULES.version;

  // Ambient ------------------------------------------------------------------------
  // The surfaces carry their apparent colours, which already hold this light's colour (every
  // pixel is the surface times the light that reached it, bounce included). So the light itself
  // is kept neutral, and the colour measured is recorded, not applied: applied, the photo's
  // warmth would appear twice (the first render of the real photograph showed exactly that).
  const bounce = obs?.illuminant.greyWorld;
  const ambientColour: Hex = "#ffffff";
  lights.push({ id: "ambient", kind: "ambient", label: bounce ? "Bounce light (neutral; its colour is in the surfaces)" : "Ambient light (assumed)", color: ambientColour });
  entities.ambient = bounce
    ? {
        kind: "light",
        presence: { basis: "estimated" },
        fields: {
          color: q(ambientColour, "inferred", [rules], `Neutral, because the surfaces' apparent colours already carry the room's light; the light's own colour is recorded in measuredColor, not applied twice.`),
          measuredColor: q(bounce.srgbHex, "estimated", ["light:illuminant.greyWorld"], `The interior's mean colour (grey-world, ${bounce.pixels.toLocaleString("en-GB")} well-exposed pixels): the colour of the light in this room, after the camera's white balance; the ceiling alone reads ${obs?.illuminant.ceiling?.cctK ?? "—"} K.`),
          cctK: q(bounce.cctK, "estimated", ["light:illuminant.greyWorld"], bounce.cctMethod),
        },
        observations: [],
        notes: ["Its strength is the renderer's own: absolute brightness is not recoverable from one photograph."],
      }
    : { kind: "light", presence: { basis: "default" }, fields: {}, observations: [], notes: ["Lighting is not estimated in this version."] };

  // Direction ------------------------------------------------------------------------
  const centre: Vec3 = [(shell.bounds.xMin + shell.bounds.xMax) / 2, shell.bounds.height / 2, (shell.bounds.zMin + shell.bounds.zMax) / 2];
  const glazed = openings.filter((o) => o.opening.kind === "window");
  let direction: LightingReport["direction"] = null;
  const combined = obs?.shading.combined;
  if (combined) {
    const d = unit(shell.dirToScene(combined.towardsLight));
    const trusted = combined.agreement >= LIGHT_RULES.directionAgreement && combined.regions >= LIGHT_RULES.directionMinRegions;
    const nearest = glazed
      .map((o) => ({ id: o.opening.id, bearingOffDeg: round(bearingOff(d, sub(openingCentre(o.opening, shell.walls), centre)), 0.1) }))
      .sort((a, b) => a.bearingOffDeg - b.bearingOffDeg)[0] ?? null;
    direction = { towardsLight: d.map((v) => round(v, 0.0001)) as unknown as Vec3, elevationDeg: round(Math.asin(Math.max(-1, Math.min(1, d[1]))) * DEG, 0.1), agreement: combined.agreement, regions: combined.regions, trusted, nearestOpening: nearest };
    if (trusted && (!nearest || nearest.bearingOffDeg > LIGHT_RULES.openingBearingDeg)) {
      problems.push(problem("light-from-no-opening", "The shading on the pieces says the light comes from a direction no opening in the model explains (a window out of frame, or a lamp behind the camera).", "warning", { towardsLight: direction.towardsLight, nearest }));
    }
  }

  // Gradient (a cross-check only) ------------------------------------------------------
  const g = obs?.gradient;
  let gradient: LightingReport["gradient"];
  if (!obs) gradient = { status: "absent", towardsBrighter: null, perMetre: null, rmseLog: null, reason: "light was not observed" };
  else if (!g || !g.horizontalTowardsBrighter) gradient = { status: "absent", towardsBrighter: null, perMetre: null, rmseLog: null, reason: "fewer than two walls or ceiling to fit" };
  else {
    const toward = unit(shell.dirToScene(g.horizontalTowardsBrighter)).map((v) => round(v, 0.0001)) as unknown as Vec3;
    const used = g.horizontalPerMetre >= LIGHT_RULES.gradientMinPerMetre && g.rmseLog <= LIGHT_RULES.gradientMaxRmse;
    gradient = {
      status: used ? "used" : "inconclusive",
      towardsBrighter: toward,
      perMetre: g.horizontalPerMetre,
      rmseLog: g.rmseLog,
      reason: used
        ? "steep and well fitted"
        : `${round(g.horizontalPerMetre * 100, 0.1)}% per metre with a fit residual of ${g.rmseLog} (log): too flat or too noisy to say where the light comes from. Phone photographs are tone-mapped, which flattens exactly this cue.`,
    };
  }

  // Daylight -------------------------------------------------------------------------
  const sunFraction = obs ? obs.sunPatches.fraction : null;
  const direct = obs ? (sunFraction! >= LIGHT_RULES.sunPatchFraction ? null : false) : null;
  const daylightOpenings = glazed.map((o) => {
    const seen = obs?.openings.find((x) => x.instanceId === o.instance);
    return { id: o.opening.id, instance: o.instance, toInterior: seen?.toInterior ?? null, clippedFraction: seen?.clippedFraction ?? null, cctK: seen?.apparent.cctK ?? null };
  });
  if (glazed.length) {
    const ids = glazed.map((o) => o.opening.id);
    const daylight: DaylightSource = { id: "daylight", kind: "daylight", label: direct === false ? "Daylight, diffuse (hour assumed)" : "Daylight (hour assumed)", openingIds: ids, ...(direct === false ? { direct: false } : {}) };
    lights.push(daylight);
    const fields: Record<string, Quantity<unknown>> = {
      timeOfDay: q(null, "default", ["priors"], "the hour is not estimated; the renderer's default is used"),
    };
    const notes = ["Daylight through the glazing that was found."];
    if (obs) {
      fields.direct = direct === false
        ? q(false, "estimated", ["light:sunPatches"], `No sunlit patch on the floor or walls (${round(sunFraction! * 100, 0.01)}% of them, under the ${LIGHT_RULES.sunPatchFraction * 100}% bar): the daylight is diffuse, so the renderer's sun is kept out.`)
        : q(null, "estimated", ["light:sunPatches"], `Bright patches on ${round(sunFraction! * 100, 0.01)}% of the floor and walls: direct sun may reach the room; the renderer's sun is left in.`);
      for (const o of daylightOpenings) {
        if (o.toInterior !== null) notes.push(`${o.id}: what is seen through it is ${o.toInterior}× the room's median brightness (${round((o.clippedFraction ?? 0) * 100, 0.1)}% clipped), about ${o.cctK} K after the camera's white balance.`);
      }
      if (direction) {
        const basis: Basis = direction.trusted ? "estimated" : "default";
        fields.direction = q(direction.towardsLight, basis, ["light:shading.combined"], `Shading on ${direction.regions} pieces points to the light (agreement ${direction.agreement}${direction.trusted ? "" : `, under the ${LIGHT_RULES.directionAgreement} bar: not trusted`}), ${direction.elevationDeg}° above level${direction.nearestOpening ? `; ${direction.nearestOpening.bearingOffDeg}° from the bearing of ${direction.nearestOpening.id}` : ""}. Not a Scene field: the openings place the light.`);
        fields["direction.elevationDeg"] = q(direction.elevationDeg, basis, ["light:shading.combined"]);
        if (direction.trusted && direction.nearestOpening && direction.nearestOpening.bearingOffDeg <= LIGHT_RULES.openingBearingDeg) {
          fields["direction.opening"] = q(direction.nearestOpening.id, "inferred", ["light:shading.combined", rules]);
          fields["direction.bearingOffDeg"] = q(direction.nearestOpening.bearingOffDeg, "estimated", ["light:shading.combined"]);
        }
      }
    }
    entities.daylight = { kind: "light", presence: { basis: "estimated" }, fields, observations: ids, notes };
  }

  // Lamps ----------------------------------------------------------------------------
  const lamps: LightingReport["lamps"][number][] = [];
  for (const p of placed) {
    if (p.object.category !== "floor-lamp") continue;
    const id = `light-${p.object.id}`;
    const instance = String(p.object.metadata?.instance ?? "");
    const seen = obs?.emission.find((e) => e.instanceId === instance)?.shade;
    const lit = seen ? seen.toSurround >= LIGHT_RULES.lampLitToSurround || seen.clippedFraction >= LIGHT_RULES.lampLitClipped : null;
    const state = lit === null ? "not-assessed" : lit ? "lit" : "unlit";
    lights.push({
      id,
      kind: "artificial",
      label: `${p.object.label} (${state === "lit" ? "seen lit" : state === "unlit" ? "seen unlit" : "not seen lit"})`,
      fixtureId: p.object.id,
      emitterOffset: [0, round(p.object.dimensions[1] - 0.15), 0],
      colorTemperature: 2700,
      ...(lit ? { on: true } : {}),
    });
    lamps.push({ lightId: id, fixtureId: p.object.id, state, toSurround: seen?.toSurround ?? null });
    const stateNote = seen
      ? lit
        ? `Seen lit: its shade is ${seen.toSurround}× as bright as what surrounds it (${round(seen.clippedFraction * 100, 0.1)}% clipped).`
        : `Seen unlit: its shade is ${seen.toSurround}× as bright as what surrounds it, under the ${LIGHT_RULES.lampLitToSurround}× bar; its switch is left to follow the daylight.`
      : "The lamp is not lit in the photograph; its switch is left to follow the daylight.";
    entities[id] = {
      kind: "light",
      presence: { basis: "inferred" },
      fields: {
        colorTemperature: q(2700, "default", ["priors"], lit ? "a lit shade's colour is the fabric's as much as the bulb's, so it is not read" : undefined),
        ...(seen ? { on: q(lit ? true : null, "estimated", [`light:emission.${instance}`, rules]) } : {}),
      },
      observations: [instance],
      notes: [stateNote],
    };
  }

  const report: LightingReport = {
    rulesVersion: LIGHT_RULES.version,
    observed: Boolean(obs),
    colour: { source: bounce ? "grey-world" : "default", hex: (bounce?.srgbHex ?? "#ffffff") as Hex, applied: ambientColour, cctK: bounce?.cctK ?? null, ceilingCctK: obs?.illuminant.ceiling?.cctK ?? null },
    direction,
    gradient,
    daylight: { openings: daylightOpenings, direct, sunPatchFraction: sunFraction },
    lamps,
    exposure: obs?.exposure ?? null,
  };
  return { lights, entities, report, problems };
}

// ---------------------------------------------------------------------------

function openingCentre(o: Opening, walls: readonly WallSurface[]): Vec3 {
  const wall = walls.find((w) => w.id === o.wallId)!;
  const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const t = o.offset / len;
  return [wall.start[0] + (wall.end[0] - wall.start[0]) * t, o.sill + o.height / 2, wall.start[1] + (wall.end[1] - wall.start[1]) * t];
}

/** Angle between two directions' horizontal bearings, degrees. */
function bearingOff(a: Vec3, b: Vec3) {
  const la = Math.hypot(a[0], a[2]);
  const lb = Math.hypot(b[0], b[2]);
  if (la < 1e-6 || lb < 1e-6) return 180;
  const c = (a[0] * b[0] + a[2] * b[2]) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, c))) * DEG;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

function q<T>(value: T, basis: Basis, sources: readonly string[], note?: string): Quantity<T> {
  return { value, basis, sigma: null, interval: null, confidence: null, sources, ...(note ? { note } : {}) };
}

function problem(code: string, message: string, severity: Problem["severity"], detail?: Record<string, unknown>): Problem {
  return { code, stage: "compile", severity, message, ...(detail ? { detail } : {}) };
}
