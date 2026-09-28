import type { CompileReport, EntityEvidence, SceneEvidence } from "@/scene/compile/evidence";
import type { Basis, Quantity, ReconstructionIntermediate } from "@/scene/compile/intermediate";
import type { Scene, SceneObject } from "@/scene/model/types";

/**
 * The reconstruction's evidence, laid out for a person to inspect.
 *
 * A reading of what the compiler already recorded — `SceneEvidence`, the
 * `CompileReport` and the worker's intermediate — and nothing more. Every
 * row keeps the basis and the sources it was recorded with. No confidence
 * is computed: none was measured, so none is shown, and a detector's score
 * is named as the raw score it is.
 */

export interface EvidenceRow {
  label: string;
  value: string;
  basis: Basis | null;
  /** The recorded sources, in readable form. */
  sources: readonly string[];
  note?: string;
}

export interface EvidenceGroup {
  title: string;
  rows: readonly EvidenceRow[];
  notes: readonly string[];
}

export interface EvidenceInput {
  scene: Scene;
  evidence: SceneEvidence;
  report: CompileReport | null;
  intermediate: ReconstructionIntermediate | null;
}

/** The basis in the compiler's own words. */
export const BASIS_WORDS: Readonly<Record<Basis, string>> = {
  measured: "measured",
  calibrated: "calibrated",
  estimated: "estimated",
  inferred: "inferred",
  default: "default",
};

const MODELS: readonly [RegExp, string][] = [
  [/^moge-2/, "MoGe-2 depth and geometry"],
  [/^geocalib/, "GeoCalib camera"],
  [/^grounding-dino/, "Grounding DINO detection"],
  [/^sam2/, "SAM 2.1 mask"],
  [/^siglip/, "SigLIP 2 material class"],
];

/** A recorded source id in words, keeping the model's version out of the way. */
export function readSource(source: string): string {
  for (const [pattern, name] of MODELS) if (pattern.test(source)) return name;
  const colon = source.indexOf(":");
  const kind = colon < 0 ? source : source.slice(0, colon);
  const rest = colon < 0 ? "" : source.slice(colon + 1);
  switch (kind) {
    case "plane": return `fitted plane ${rest}`;
    case "rule": return `rule ${rest}`;
    case "priors":
    case "vocabulary": return "the category's typical values";
    case "assumption": return `assumption: ${rest.replace(/-/g, " ")}`;
    case "calibration": return `your calibration (${rest})`;
    case "scale": return rest === "depth-model" ? "the depth model's scale" : `scale: ${rest}`;
    default: return source;
  }
}

const unique = (xs: readonly string[]) => [...new Set(xs)];
const sourcesOf = (q: Quantity<unknown> | undefined) => unique((q?.sources ?? []).map(readSource));
const metres = (v: unknown) => (typeof v === "number" ? `${v.toFixed(2)} m` : "—");

function row(label: string, q: Quantity<unknown> | undefined, value: (v: unknown) => string = String): EvidenceRow | null {
  if (!q) return null;
  return { label, value: value(q.value), basis: q.basis, sources: sourcesOf(q), ...(q.note ? { note: q.note } : {}) };
}

const rows = (xs: readonly (EvidenceRow | null)[]) => xs.filter((r): r is EvidenceRow => r !== null);

/** How every length is scaled: the depth model's own, or calibrated to the person's references. */
export function scaleRow(evidence: SceneEvidence): EvidenceRow {
  const { scale } = evidence;
  if (scale.basis === "calibrated") {
    const n = scale.references.length;
    return {
      label: "Scale",
      value: `× ${scale.factor.toFixed(3)} from ${n} reference${n === 1 ? "" : "s"}`,
      basis: "calibrated",
      sources: ["your calibration"],
      note: "One factor applied to every length in the room; object sizes are not scaled one by one.",
    };
  }
  return {
    label: "Scale",
    value: "the depth model's metric estimate",
    basis: "estimated",
    sources: ["MoGe-2 depth and geometry"],
    note: "Not calibrated: every length shares one unknown scale error.",
  };
}

/** Room, camera, planes, depth and scale, materials and lighting. */
export function roomEvidence({ scene, evidence, report, intermediate }: EvidenceInput): EvidenceGroup[] {
  const e = evidence.entities;
  const room = e.room;
  const camera = e.camera;
  const groups: EvidenceGroup[] = [];

  groups.push({
    title: "Room",
    rows: rows([
      row("Width", room?.fields.width, metres),
      row("Depth", room?.fields.depth, metres),
      row("Height", room?.fields.height, metres),
      ...(report
        ? (["left", "far", "right", "behind"] as const).map((side) => {
            const s = report.sides[side];
            return { label: `${side[0].toUpperCase()}${side.slice(1)} side`, value: s.status === "observed" ? `seen (${s.planeId})` : s.status, basis: s.basis, sources: s.planeId ? [readSource(`plane:${s.planeId}`)] : [] };
          })
        : []),
    ]),
    notes: room?.notes ?? [],
  });

  groups.push({
    title: "Camera",
    rows: rows([
      row("Field of view", camera?.fields.verticalFov, (v) => (typeof v === "number" ? `${v.toFixed(1)}° vertical` : "—")),
      row("Height", camera?.fields["position.1"], metres),
      row("Roll", camera?.fields.roll, (v) => (typeof v === "number" ? `${v.toFixed(1)}°` : "—")),
      ...(intermediate
        ? [
            { label: "Focal length", ...fromQuantity(intermediate.views[0]?.camera.intrinsics.fx, (v) => `${Math.round(Number(v))} px`) },
            { label: "Principal point", ...fromQuantity(intermediate.views[0]?.camera.intrinsics.cx, () => "image centre") },
          ].filter((r) => r.value !== undefined) as EvidenceRow[]
        : []),
    ]),
    notes: camera?.notes ?? [],
  });

  if (intermediate) {
    const used = new Map(report?.planes.used.map((u) => [u.id, u.as]) ?? []);
    const ignored = new Map(report?.planes.ignored.map((i) => [i.id, i.reason]) ?? []);
    groups.push({
      title: "Planes",
      rows: intermediate.world.planes.map((p) => ({
        label: p.id,
        value: `${p.role}${used.has(p.id) ? ` → ${used.get(p.id)}` : ""} · ${p.visibleArea.toFixed(1)} m² seen · fit ${(p.rmsResidual * 1000).toFixed(0)} mm RMS`,
        basis: "estimated" as const,
        sources: ["MoGe-2 depth and geometry", `plane fit (${p.method})`],
        ...(ignored.has(p.id) ? { note: `not used: ${ignored.get(p.id)}` } : {}),
      })),
      notes: [
        `${intermediate.world.planes.length} planes were fitted to the depth; ${used.size} became the room's surfaces.`,
        "Visible areas are before calibration; a plane's visible extent is a lower bound on the surface.",
      ],
    });

    const geometry = intermediate.views[0]?.geometry as { scale?: { note?: string } } | undefined;
    groups.push({
      title: "Depth and scale",
      rows: [
        { label: "Depth", value: "one photograph, monocular depth", basis: "estimated", sources: ["MoGe-2 depth and geometry"] },
        scaleRow(evidence),
        ...evidence.scale.references.map((r, i) => ({
          label: `Reference ${i + 1}`,
          value: `${r.label ?? (r.kind === "room-height" ? "room height" : `distance on ${r.planeId}`)}: ${r.metres} m`,
          basis: "measured" as const,
          sources: ["you"],
          note: `residual ${((evidence.scale.residuals[i] ?? 0) * 100).toFixed(1)}%`,
        })),
      ],
      notes: geometry?.scale?.note ? [geometry.scale.note] : [],
    });
  }

  if (report) {
    const byBasis = countBy(report.materials.assigned.map((a) => a.classBasis));
    groups.push({
      title: "Materials",
      rows: [
        { label: "Finishes", value: `${report.materials.assigned.length} read from the photograph`, basis: null, sources: ["SigLIP 2 material class"] },
        ...Object.entries(byBasis).map(([basis, n]) => ({ label: `Class ${basis}`, value: `${n}`, basis: basis as Basis, sources: [] })),
        ...report.materials.notEstimated.map((m) => ({ label: m.target, value: "not estimated", basis: "default" as const, sources: [], note: m.reason })),
      ],
      notes: ["Colours are the surfaces under this photograph's light, not their own colour."],
    });

    const l = report.lighting;
    groups.push({
      title: "Lighting",
      rows: [
        { label: "Light colour", value: l.colour.cctK ? `about ${Math.round(l.colour.cctK / 10) * 10} K` : l.colour.hex, basis: l.colour.source === "default" ? "default" : "estimated", sources: [l.colour.source === "default" ? "default" : "grey-world estimate from the photograph"] },
        { label: "Direction", value: l.direction ? (l.direction.trusted ? `from shading, ${Math.round(l.direction.elevationDeg)}° up` : "inconclusive") : "not read", basis: l.direction?.trusted ? "estimated" : "default", sources: l.direction ? ["shading on the pieces"] : [] },
        { label: "Daylight", value: l.daylight.openings.length ? `${l.daylight.openings.length} opening${l.daylight.openings.length === 1 ? "" : "s"}${l.daylight.direct ? ", direct sun" : ""}` : "none seen", basis: l.daylight.openings.length ? "estimated" : "default", sources: [] },
        { label: "Lights", value: `${scene.lights.length} in the room`, basis: null, sources: [] },
      ],
      notes: l.observed ? [] : ["The light was not read from this photograph; neutral defaults are used."],
    });
  }

  return groups;
}

function fromQuantity(q: Quantity<unknown> | undefined, value: (v: unknown) => string): Omit<EvidenceRow, "label"> | { value: undefined } {
  if (!q) return { value: undefined };
  return { value: value(q.value), basis: q.basis, sources: sourcesOf(q), ...(q.note ? { note: q.note } : {}) };
}

function countBy(xs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

/** The weakest of several bases. */
export function weakest(bases: readonly Basis[]): Basis | null {
  const order: readonly Basis[] = ["measured", "calibrated", "estimated", "inferred", "default"];
  return bases.length ? bases.reduce((w, b) => (order.indexOf(b) > order.indexOf(w) ? b : w)) : null;
}

/**
 * One piece: how it was detected, what its mask and depth were, how it was
 * placed and turned, what scale its sizes share, and what it is drawn as.
 * Null for a piece with no evidence — one added or replaced since.
 */
export function objectEvidence(object: SceneObject, { evidence, intermediate }: Pick<EvidenceInput, "evidence" | "intermediate">): EvidenceGroup | null {
  const entity: EntityEvidence | undefined = evidence.entities[object.id];
  if (!entity || entity.kind !== "object") return null;
  const f = entity.fields;
  const instance = intermediate?.world.instances?.find((i) => entity.observations.includes(i.id));
  const size = (["dimensions.0", "dimensions.1", "dimensions.2"] as const).map((k) => f[k]).filter(Boolean) as Quantity<unknown>[];
  const sizeBasis = weakest(size.map((q) => q.basis));
  const typical = size.filter((q) => q.basis === "inferred" || q.basis === "default").length;

  return {
    title: "Evidence",
    rows: rows([
      f.category
        ? { label: "Detection", value: f.category.note ?? String(f.category.value), basis: f.category.basis, sources: sourcesOf(f.category), note: "The score is the detector's raw output, not a probability." }
        : null,
      instance
        ? { label: "Mask", value: `${instance.id}, mask score ${instance.mask.score.toFixed(2)} (raw)`, basis: "estimated", sources: ["SAM 2.1 mask"] }
        : null,
      instance?.points
        ? { label: "Depth", value: `${instance.points.count.toLocaleString()} points, median ${instance.points.depthMedian.toFixed(2)} m from the camera`, basis: "estimated", sources: ["MoGe-2 depth and geometry"], note: "Before calibration." }
        : instance
          ? { label: "Depth", value: "too few points on the piece", basis: "default", sources: [] }
          : null,
      row("Placement", f["transform.position"], () => "from its visible points"),
      row("Turn", f["transform.rotation.1"], (v) => (typeof v === "number" ? `${Math.round(v)}°` : "—")),
      row("Stands on", f.support),
      sizeBasis
        ? { label: "Size", value: typical === 0 ? "from what was seen" : typical === size.length ? "the category's typical size" : `${typical} of 3 axes typical`, basis: sizeBasis, sources: unique(size.flatMap(sourcesOf)), note: size.map((q, i) => `${["width", "height", "depth"][i]} ${BASIS_WORDS[q.basis]}`).join(" · ") }
        : null,
      scaleRow(evidence),
      { label: "Drawn as", value: `a parametric ${object.category.replace(/-/g, " ")}${object.form ? `, ${object.form.replace(/-/g, " ")} form` : ""}`, basis: f.form?.basis ?? "default", sources: sourcesOf(f.form), ...(f.form?.note ? { note: f.form.note } : {}) },
    ]),
    notes: [...entity.notes, ...(entity.alternatives ?? []).map((a) => `Also read as ${a.value} (raw score ${a.score.toFixed(2)}).`)],
  };
}
