"use client";

import { useEffect } from "react";
import { useStore, useWorkspace } from "../state/store";
import styles from "./ChangeProposal.module.css";

/** How long the confirmation of an applied change stays up. */
const RECEIPT_MS = 5000;

/**
 * What the interpreter made of a command, before and after it happens.
 *
 * Understood: the changes, grouped by what they touch, each previewed in
 * the room — the same preview the renderer uses for everything else,
 * applied to the store's scene rather than to the document. Nothing enters
 * the history until Apply, and then the command enters it as one step:
 * one undo takes back everything it did.
 *
 * Understood but not available: the request exactly as it was read, so it
 * is plain the words were understood, with no pretence it can be done.
 *
 * Applied: a short confirmation, with the way back.
 *
 * Only an interpreter produces these: in this build, the rule-based reader,
 * and later a language model behind the same interface.
 */
export function ChangeProposal() {
  const proposal = useWorkspace((s) => s.proposal);
  const limitation = useWorkspace((s) => s.limitation);
  const receipt = useWorkspace((s) => s.receipt);
  if (proposal) return <Understood />;
  if (limitation) return <Unavailable />;
  if (receipt) return <Applied />;
  return null;
}

function Understood() {
  const store = useStore();
  const proposal = useWorkspace((s) => s.proposal);
  const previewing = useWorkspace((s) => s.previewing);
  if (!proposal) return null;

  const kept = proposal.changes.filter((change) => previewing.has(change.id)).length;
  const groups = [...new Set(proposal.changes.map((change) => change.group))];

  return (
    <section className={styles.card} aria-label="Proposed changes">
      <header className={styles.head}>
        <p className={styles.kicker}>
          <span className={styles.state}>Understood</span>
          <span className={styles.command}>{proposal.command}</span>
        </p>
        <p className={styles.summary}>{proposal.summary}</p>
      </header>

      <div className={styles.changes}>
        {groups.map((group) => (
          <div key={group} className={styles.group}>
            <p className={styles.groupTitle}>{group}</p>
            <ul>
              {proposal.changes
                .filter((change) => change.group === group)
                .map((change) => (
                  <li key={change.id}>
                    <label className={styles.change}>
                      <input
                        type="checkbox"
                        className={styles.tick}
                        checked={previewing.has(change.id)}
                        onChange={() => store.togglePreview(change.id)}
                      />
                      <span className={styles.changeTarget}>{change.target}</span>
                      <span className={styles.changeDetail}>{change.detail}</span>
                    </label>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>

      <footer className={styles.foot}>
        <span className={styles.count}>
          {kept} of {proposal.changes.length} previewed in the room
        </span>
        <div className={styles.buttons}>
          <button type="button" className={styles.discard} onClick={() => store.discardProposal()}>
            Discard
          </button>
          <button type="button" className={styles.apply} disabled={kept === 0} onClick={() => store.acceptProposal()}>
            Apply
          </button>
        </div>
      </footer>
    </section>
  );
}

function Unavailable() {
  const store = useStore();
  const limitation = useWorkspace((s) => s.limitation);
  if (!limitation) return null;
  const { request } = limitation;

  return (
    <section className={styles.card} aria-label="Understood, not available yet">
      <header className={styles.head}>
        <p className={styles.kicker}>
          <span className={styles.state} data-tone="limited">
            Understood · not available yet
          </span>
          <span className={styles.command}>{limitation.command}</span>
        </p>
        <p className={styles.summary}>Change object</p>
      </header>
      <dl className={styles.request}>
        <div>
          <dt>Target</dt>
          <dd>{request.targetLabel}</dd>
        </div>
        <div>
          <dt>Requested form</dt>
          <dd>{request.requestedForm}</dd>
        </div>
        {request.requestedAttributes.length > 0 && (
          <div>
            <dt>Also asked for</dt>
            <dd>{request.requestedAttributes.join(", ")}</dd>
          </div>
        )}
      </dl>
      <footer className={styles.foot}>
        <p className={styles.limit} role="status">
          {limitation.message}
        </p>
        <button type="button" className={styles.discard} onClick={() => store.discardProposal()}>
          Dismiss
        </button>
      </footer>
    </section>
  );
}

function Applied() {
  const store = useStore();
  const receipt = useWorkspace((s) => s.receipt);

  useEffect(() => {
    if (!receipt) return;
    const timer = window.setTimeout(() => store.clearReceipt(), RECEIPT_MS);
    return () => window.clearTimeout(timer);
  }, [receipt, store]);

  if (!receipt) return null;
  return (
    <section className={styles.receipt} aria-label="Applied" role="status">
      <span className={styles.state} data-tone="done">
        Applied
      </span>
      <span className={styles.receiptText}>
        {receipt.title}. {receipt.changes === 1 ? "One change" : `${receipt.changes} changes`}, one step in the history.
      </span>
      <button
        type="button"
        className={styles.undo}
        onClick={() => {
          // The whole command is one history entry.
          store.undo();
          store.clearReceipt();
        }}
      >
        Undo
      </button>
    </section>
  );
}
