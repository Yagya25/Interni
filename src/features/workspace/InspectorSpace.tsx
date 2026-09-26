"use client";

import { findById } from "@/scene/model/queries";
import type { Id, Opening } from "@/scene/model/types";
import { Reading } from "./controls/Controls";
import { FLAT } from "./design/layout/roles";
import {
  basisOf,
  formatMeasurement,
  formatSeries,
  knowledgeOf,
  measureScene,
  measureWalkway,
  sizeOf,
  type EndedBy,
  type Measured,
  type ObjectMeasurements,
} from "./measure";
import { Section } from "./panels/Panel";
import { useWorkspaceSource } from "./sourceContext";
import { useWorkspace } from "./state/store";
import { useSettled } from "./useSettled";
import styles from "./Inspector.module.css";

/**
 * A reconstructed piece's size, no finer than it is known: "≈ 2.2 × 0.90 ×
 * 0.95 m", with what the numbers cannot claim said beneath. The
 * demonstration room's authored sizes keep their authored figures.
 */
export function SizeReading({ id, fallback }: { id: Id; fallback: string }) {
  const scene = useWorkspace((s) => s.scene);
  const evidence = useWorkspaceSource()?.evidence;
  const object = findById(scene.objects, id);
  if (!evidence || !object) return <Reading label="Size" value={fallback} />;
  const { width, depth, height } = sizeOf(knowledgeOf(scene, evidence), object);
  const axes = [["width", width], ["depth", depth], ["height", height]] as const;
  const partly = axes.filter(([, m]) => m.available && m.bound === "at-least").map(([name]) => name);
  const typical = axes.filter(([, m]) => m.available && m.bound === "typical").map(([name]) => name);
  const notes = [
    [...new Set(axes.map(([, m]) => basisOf(m)))].join(", "),
    partly.length ? `${partly.join(", ")} at least this (seen in part)` : null,
    typical.length ? `${typical.join(", ")} typical (not seen)` : null,
  ].filter(Boolean);
  return (
    <Reading
      label="Size"
      value={
        <>
          {formatSeries([width, depth, height])}
          <span className={styles.qualifier}>{notes.join(" · ")}</span>
        </>
      }
    />
  );
}

/**
 * The floor around a piece: what is in front of it, what is nearest, the
 * wall, and how wide the way to it is from the door. Plan distances,
 * measured on the room once it comes to rest, each with how it is known.
 */
export function SpaceSection({ id }: { id: Id }) {
  const scene = useWorkspace((s) => s.scene);
  const evidence = useWorkspaceSource()?.evidence ?? null;
  const { value: settled, settling } = useSettled(scene);
  const piece = measureScene(settled, evidence).objects.find((o) => o.id === id);
  const object = findById(settled.objects, id);
  if (!piece || !object) return null;
  // A person walks to what stands on the floor; a rug is walked over.
  const onFloor = object.support.kind === "floor" && piece.size.height.available && piece.size.height.value > FLAT;
  const way = onFloor ? measureWalkway(settled, evidence, id) : null;
  const named = (openingId: Id) => findById<Opening>(settled.openings, openingId)?.label.toLowerCase() ?? "the doorway";

  const rows = [
    piece.front && { label: "In front", ...runTo(piece.front.depth, piece.front.endedBy) },
    piece.nearest && { label: "Nearest", ...runTo(piece.nearest.distance, { kind: "object", id: piece.nearest.id, label: piece.nearest.label }) },
    piece.wall && { label: "Wall", ...wallRow(piece, object.support.kind === "wall") },
    object.support.kind === "wall" && { label: "Off floor", text: formatMeasurement(piece.bounds.bottom), basis: basisOf(piece.bounds.bottom) },
    way &&
      (way.reachable
        ? { label: "Way in", text: `${formatMeasurement(way.width)} at its narrowest, from the ${named(way.from)}`, basis: basisOf(way.width) }
        : { label: "Way in", text: way.reason, basis: null }),
  ].filter((r): r is { label: string; text: string; basis: string | null } => Boolean(r));
  if (!rows.length) return null;

  return (
    <Section title="Space">
      <dl data-settling={settling || undefined} className={styles.space}>
        {rows.map((r) => (
          <Reading
            key={r.label}
            label={r.label}
            value={
              <>
                {r.text}
                {r.basis && <span className={styles.qualifier}>{r.basis}</span>}
              </>
            }
          />
        ))}
      </dl>
    </Section>
  );
}

/** "≈ 0.35 m to Armchair 2", or "against the far wall" when the gap is finer than it is known. */
function runTo(m: Measured, end: EndedBy) {
  const to = end.kind === "wall" ? `the ${end.label.toLowerCase()}` : end.label;
  const touching = m.available && m.rounded === 0;
  return { text: touching ? `against ${to}` : `${formatMeasurement(m)} to ${to}`, basis: basisOf(m) };
}

function wallRow(piece: ObjectMeasurements, hangs: boolean) {
  const wall = piece.wall!;
  const name = `the ${wall.label.toLowerCase()}`;
  if (wall.touching) return { text: hangs ? `on ${name}` : `against ${name}`, basis: basisOf(wall.gap) };
  return { text: `${formatMeasurement(wall.gap)} from ${name}`, basis: basisOf(wall.gap) };
}
