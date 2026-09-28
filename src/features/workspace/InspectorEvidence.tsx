"use client";

import type { SceneObject } from "@/scene/model/types";
import { EvidenceRows } from "./panels/EvidenceRows";
import { Section } from "./panels/Panel";
import { objectEvidence } from "./reconstruction/trust/evidence";
import { useWorkspaceSource } from "./sourceContext";

/**
 * A reconstructed piece's evidence: how it was detected, its mask and depth,
 * how it was placed and turned, the scale its sizes share, and what it is
 * drawn as. Nothing for a piece added or replaced since — it has none.
 */
export function InspectorEvidence({ object }: { object: SceneObject }) {
  const source = useWorkspaceSource();
  if (!source?.evidence) return null;
  const group = objectEvidence(object, { evidence: source.evidence, intermediate: source.intermediate ?? null });
  if (!group) return null;
  return (
    <Section title="Evidence">
      <EvidenceRows group={group} />
    </Section>
  );
}
