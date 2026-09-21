"use client";

import type { ReactNode } from "react";
import { CloseIcon } from "../icons";
import styles from "./panels.module.css";

interface PanelProps {
  id: string;
  title: string;
  /** One line under the title, when the panel needs framing. */
  summary?: string;
  /** Which edge of the room it sits against. Tools left, context right. */
  side?: "left" | "right";
  onClose: () => void;
  children: ReactNode;
}

/** The chrome every panel shares: a ruled head, and a scrolling body. */
export function Panel({ id, title, summary, side = "left", onClose, children }: PanelProps) {
  return (
    <aside
      className={styles.panel}
      data-region={side === "left" ? "panel" : "inspector"}
      data-side={side}
      id={id}
      aria-label={title}
    >
      <header className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        <button type="button" className={styles.close} onClick={onClose}>
          <CloseIcon />
          <span className="visually-hidden">Close {title.toLowerCase()}</span>
        </button>
        {summary && <p className={styles.summary}>{summary}</p>}
      </header>
      <div className={styles.body}>{children}</div>
    </aside>
  );
}

/** A ruled division inside a panel. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

/** Said plainly, where there is nothing to show or nothing to do. */
export function Note({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}
