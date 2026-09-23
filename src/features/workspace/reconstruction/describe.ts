import type { EntityEvidence } from "@/scene/compile/evidence";
import type { Material } from "@/scene/model/types";

/**
 * Readings for what the reconstruction found, in the words a person would
 * use. Each describes the finish or the light as it was found; once it is
 * edited, the evidence no longer belongs to it and nothing is shown.
 */

const CLASS_HOW: Record<string, string> = {
  estimated: "read from the photo",
  inferred: "follows from what it is",
  default: "typical; the photo could not tell",
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One line for a reconstructed finish: its class and how that is known, its colour, its roughness and pattern. */
export function describeFinish(material: Material | undefined, entity: EntityEvidence | undefined): string | null {
  if (!material || !entity || entity.kind !== "material" || !entity.fields.class) return null;
  const f = entity.fields;
  const parts = [`${capital(material.class)}, ${CLASS_HOW[f.class.basis] ?? f.class.basis}`];
  if (f.color) parts.push(`${material.color} as photographed`);
  if (f.roughness) {
    parts.push(f.roughness.basis === "estimated" ? `roughness ${material.roughness}, measured from its reflections` : `roughness ${material.roughness}, typical`);
  }
  if (material.pattern !== "none" && f.pattern) {
    const size = material.patternScale && material.pattern === "tiles" ? ` ${round2(material.patternScale / 4)} m` : "";
    parts.push(f.pattern.basis === "estimated" ? `${material.pattern}${size}, measured` : f.pattern.basis === "default" ? `${material.pattern}${size}, size assumed` : `${material.pattern}, typical`);
  }
  return parts.join(" · ");
}

/** The room's light colour as measured in the photograph, which the surfaces' colours already carry. */
export function describeAmbient(entity: EntityEvidence | undefined): string | null {
  const measured = entity?.fields.measuredColor?.value;
  if (!entity || typeof measured !== "string") return null;
  const k = entity.fields.cctK?.value;
  return `${measured}${typeof k === "number" ? `, about ${Math.round(k / 10) * 10} K` : ""} in the photo — carried by the surfaces' colours, so the light itself is kept neutral`;
}

/** How the daylight was found: diffuse or direct, and where it comes from. */
export function describeDaylight(entity: EntityEvidence | undefined): { kind: string | null; from: string | null } {
  if (!entity) return { kind: null, from: null };
  const direct = entity.fields.direct;
  const kind = !direct ? null : direct.value === false ? "Diffuse — no sunlit patch in the photo" : "Direct sun may reach the room";
  const opening = entity.fields["direction.opening"]?.value;
  const off = entity.fields["direction.bearingOffDeg"]?.value;
  const up = entity.fields["direction.elevationDeg"]?.value;
  const from =
    typeof opening === "string" && typeof off === "number" && typeof up === "number"
      ? `${opening}, within ${Math.round(off)}° of its bearing, ${Math.round(up)}° above level (from shading on the pieces)`
      : null;
  return { kind, from };
}

/** Whether a lamp was seen lit, as found. */
export function describeLamp(entity: EntityEvidence | undefined): string | null {
  const on = entity?.fields.on;
  if (!on) return null;
  return on.value === true ? "Seen lit in the photo" : "Seen unlit in the photo";
}

const round2 = (v: number) => Math.round(v * 100) / 100;
