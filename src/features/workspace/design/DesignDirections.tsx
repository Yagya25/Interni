"use client";

import { useState } from "react";
import { useStore, useWorkspace } from "../state/store";
import styles from "./DesignDirections.module.css";
import type { DesignProposal } from "./proposal";

/**
 * Directions for the room.
 *
 * Not a dashboard and not a gallery: a narrow column of cards beside the
 * room, because the room is what is being designed and it stays the thing
 * you are looking at. Each card is a plan — what it would change, why, and
 * what it deliberately leaves alone — and nothing on it has touched the
 * document. Preview lays one over the room; Apply hands it to the history
 * as a single step, which one undo takes back. A layout is a card like any
 * other: directions side by side, none scored and none called the best.
 */
export function DesignDirections() {
  const store = useStore();
  const design = useWorkspace((s) => s.design);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!design) return null;

  const { proposals, previewId, appliedId } = design;

  return (
    <aside className={styles.rail} aria-label="Design directions">
      <header className={styles.head}>
        <p className={styles.kicker}>
          <span className={styles.state}>Design</span>
          <span className={styles.count}>
            {proposals.length === 1 ? "One direction" : `${proposals.length} directions`}
          </span>
        </p>
        <p className={styles.request}>{design.request}</p>
        <button type="button" className={styles.dismiss} onClick={() => store.dismissDesigns()}>
          Close
        </button>
      </header>

      <ul className={styles.cards}>
        {proposals.map((proposal) => (
          <li key={proposal.id}>
            <Card
              proposal={proposal}
              previewing={proposal.id === previewId}
              applied={proposal.id === appliedId}
              open={expanded === proposal.id}
              onToggle={() => setExpanded(expanded === proposal.id ? null : proposal.id)}
            />
          </li>
        ))}
      </ul>

      {design.rejected.length > 0 && (
        <p className={styles.rejected} role="status">
          {design.rejected.length === 1 ? "One direction was" : `${design.rejected.length} directions were`} left out:{" "}
          {design.rejected[0].reason}
        </p>
      )}
    </aside>
  );
}

interface CardProps {
  proposal: DesignProposal;
  previewing: boolean;
  applied: boolean;
  open: boolean;
  onToggle: () => void;
}

function Card({ proposal, previewing, applied, open, onToggle }: CardProps) {
  const store = useStore();
  const { preview } = proposal;

  return (
    <article className={styles.card} data-previewing={previewing || undefined} data-applied={applied || undefined}>
      <h3 className={styles.title}>{proposal.title}</h3>
      <p className={styles.note}>{proposal.description}</p>

      <p className={styles.measures}>
        {preview.movedObjectCount > 0 && <span>{preview.movedObjectCount === 1 ? "1 piece moved" : `${preview.movedObjectCount} pieces moved`}</span>}
        {preview.changedMaterialCount > 0 && <span>{preview.changedMaterialCount} finishes</span>}
        {preview.restyledObjectCount > 0 && <span>{preview.restyledObjectCount} pieces</span>}
        {preview.changedLightCount > 0 && <span>{preview.changedLightCount === 1 ? "1 light" : `${preview.changedLightCount} lights`}</span>}
      </p>

      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.preview}
          onClick={() => (previewing ? store.exitDesignPreview() : store.previewDesign(proposal.id))}
        >
          {previewing ? "Exit preview" : "Preview"}
        </button>
        <button type="button" className={styles.apply} onClick={() => store.applyDesign(proposal.id)}>
          Apply
        </button>
        <button type="button" className={styles.why} aria-expanded={open} onClick={onToggle}>
          {open ? "Less" : "Why"}
        </button>
      </div>

      {open && (
        <div className={styles.detail}>
          <p className={styles.detailTitle}>What it changes</p>
          <ul className={styles.changes}>
            {proposal.changes.map((change) => (
              <li key={change.id}>
                <span className={styles.changeTarget}>{change.target}</span>
                <span className={styles.changeDetail}>{change.detail}</span>
              </li>
            ))}
          </ul>
          <p className={styles.detailTitle}>Why</p>
          <ul className={styles.reasons}>
            {proposal.rationale.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className={styles.detailTitle}>What it leaves alone</p>
          <ul className={styles.reasons}>
            {proposal.constraints.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className={styles.step}>
            {preview.operationCount} changes, applied as one step in the history.
          </p>
        </div>
      )}
    </article>
  );
}
