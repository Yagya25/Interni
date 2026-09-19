"use client";

import { useEffect, useRef } from "react";
import { chapters } from "./chapters";
import styles from "./ProgressRail.module.css";
import { sequenceStore, useChapterIndex } from "./store";

/**
 * Scroll progress that is also a table of contents. The fill is written
 * straight to the DOM; only chapter changes re-render.
 */
export function ProgressRail() {
  const active = useChapterIndex();
  const fillRef = useRef<HTMLSpanElement>(null);

  useEffect(
    () =>
      sequenceStore.onProgress((progress) => {
        if (fillRef.current) fillRef.current.style.transform = `scaleY(${progress.toFixed(4)})`;
      }),
    [],
  );

  return (
    <nav className={styles.rail} aria-label="Chapters" data-print="hide" data-visible={active >= 0 && active < chapters.length}>
      <span className={styles.track} aria-hidden="true">
        <span ref={fillRef} className={styles.fill} />
      </span>
      <ol className={styles.list}>
        {chapters.map((chapter, i) => (
          <li key={chapter.id}>
            <button
              type="button"
              className={styles.item}
              data-state={i === active ? "active" : i < active ? "past" : "future"}
              aria-current={i === active ? "step" : undefined}
              onClick={() => sequenceStore.seek(i)}
            >
              <span className={styles.index}>{chapter.index}</span>
              <span className={styles.label}>{chapter.label}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
