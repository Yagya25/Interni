"use client";

import { useMemo } from "react";
import { roomEvidence } from "../reconstruction/trust/evidence";
import { useWorkspaceSource } from "../sourceContext";
import { useStore, useWorkspace } from "../state/store";
import { EvidenceRows, RunStatus, useRunExplanation } from "./EvidenceRows";
import { Note, Panel, Section } from "./Panel";
import styles from "./panels.module.css";

/**
 * How the reconstructed room is known: the run's status, then the room,
 * camera, planes, depth and scale, finishes and light, each value with the
 * basis and sources the compiler recorded. A piece's own evidence is in the
 * inspector; the list below opens it.
 *
 * It reads the evidence of the room as reconstructed. Edits change the
 * room, not what the photograph showed, and the measurements say so.
 */
export function EvidencePanel() {
  const store = useStore();
  const source = useWorkspaceSource();
  const scene = useWorkspace((s) => s.doc.scene);
  const selection = useWorkspace((s) => s.selection);
  const explanation = useRunExplanation(source);
  const evidence = source?.evidence;
  const groups = useMemo(
    () => (evidence ? roomEvidence({ scene, evidence, report: source?.report ?? null, intermediate: source?.intermediate ?? null }) : []),
    [scene, evidence, source?.report, source?.intermediate],
  );
  const found = scene.objects.filter((o) => evidence?.entities[o.id]?.kind === "object");

  return (
    <Panel
      id="panel-evidence"
      title="Evidence"
      summary="How each value was known: measured, calibrated, estimated, inferred or a stated default."
      onClose={() => store.setTool(null)}
    >
      {explanation && (
        <Section title="Reconstruction">
          <RunStatus explanation={explanation} />
        </Section>
      )}
      {!evidence && (
        <div className={styles.section}>
          <Note>This room was not reconstructed from a photograph, so there is no evidence to show.</Note>
        </div>
      )}
      {groups.map((group) => (
        <Section key={group.title} title={group.title}>
          <EvidenceRows group={group} />
        </Section>
      ))}
      {found.length > 0 && (
        <Section title="Objects">
          <Note>Choose a piece to see how it was detected, placed and sized.</Note>
        </Section>
      )}
      {found.length > 0 && (
        <ul className={styles.rows}>
          {found.map((o) => (
            <li key={o.id}>
              <button type="button" className={styles.row} data-on={selection === o.id || undefined} onClick={() => store.select(o.id)}>
                <span className={styles.rowName}>{o.label}</span>
                <span className={styles.rowMeta}>{evidence?.entities[o.id]?.fields["dimensions.0"]?.basis ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
