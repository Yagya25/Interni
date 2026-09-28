"use client";

import { useMemo } from "react";
import { explainRun, type Explanation } from "../reconstruction/trust/diagnostics";
import type { EvidenceGroup } from "../reconstruction/trust/evidence";
import type { WorkspaceSource } from "../sourceContext";
import { useStore, useWorkspace } from "../state/store";
import styles from "./trust.module.css";

/** One group of evidence: each value with how it is known and where it came from. */
export function EvidenceRows({ group }: { group: EvidenceGroup }) {
  return (
    <>
      <dl className={styles.list}>
        {group.rows.map((row, i) => (
          <div key={`${row.label}-${i}`} className={styles.item}>
            <dt className={styles.label}>{row.label}</dt>
            <dd className={styles.value}>{row.value}</dd>
            {(row.basis || row.sources.length > 0) && (
              <dd className={styles.meta}>
                {row.basis && (
                  <span className={styles.basis} data-basis={row.basis}>
                    {row.basis}
                  </span>
                )}
                {row.sources.length > 0 && <span>{row.sources.join(" · ")}</span>}
              </dd>
            )}
            {row.note && <dd className={styles.note}>{row.note}</dd>}
          </div>
        ))}
      </dl>
      {group.notes.length > 0 && (
        <div className={styles.notes}>
          {group.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
    </>
  );
}

/** How the worker's run went, from its own diagnostics. Null for a room with no reconstruction behind it. */
export function useRunExplanation(source: WorkspaceSource | null): Explanation | null {
  const intermediate = source?.intermediate;
  const scale = source?.scale ?? "estimated";
  return useMemo(() => (intermediate ? explainRun(intermediate.diagnostics, scale) : null), [intermediate, scale]);
}

/** The run's status said plainly, with the next useful step. */
export function RunStatus({ explanation }: { explanation: Explanation }) {
  const store = useStore();
  const tool = useWorkspace((s) => s.tool);
  return (
    <div className={styles.status} data-status={explanation.status} data-run-status="">
      <p className={styles.headline}>{explanation.headline}</p>
      {explanation.reasons.map((r) => (
        <p key={r.code} className={styles.reason}>
          <span className="visually-hidden">Reason: </span>
          {r.text}
        </p>
      ))}
      {explanation.calibrated && <p className={styles.reason}>{explanation.calibrated}</p>}
      {explanation.action && tool !== "calibrate" && (
        <button type="button" className={styles.action} onClick={() => store.setTool("calibrate")}>
          {explanation.action.label}
        </button>
      )}
    </div>
  );
}
