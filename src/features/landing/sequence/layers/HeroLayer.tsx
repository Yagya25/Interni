import type { RefObject } from "react";
import { ButtonLink } from "@/components/Button";
import { StatusState } from "@/components/StatusState";
import { anchors, routes } from "@/config/site";
import styles from "./HeroLayer.module.css";

export type StageStatus = "loading" | "ready" | "error";
/** Why the stage could not run, so the message can be accurate. */
export type StageError = "webgl" | "load" | "lost";

const errorCopy: Record<StageError, { title: string; description: string }> = {
  webgl: {
    title: "The 3D view could not start here.",
    description: "This browser didn’t provide WebGL. The walkthrough continues as text.",
  },
  load: {
    title: "The 3D view didn’t load.",
    description: "Check your connection and reload. The walkthrough continues as text.",
  },
  lost: {
    title: "The 3D view stopped.",
    description: "The graphics context was lost. Reloading the page usually brings it back.",
  },
};

interface HeroLayerProps {
  frameRef: RefObject<HTMLDivElement | null>;
  loaderBarRef: RefObject<HTMLSpanElement | null>;
  status: StageStatus;
  error?: StageError;
}

export function HeroLayer({ frameRef, loaderBarRef, status, error = "webgl" }: HeroLayerProps) {
  return (
    <div className={styles.hero}>
      {/* The photograph is composed into this box. It never moves, so the
          stage can measure it at any scroll position. */}
      <div ref={frameRef} className={styles.frame} data-status={status}>
        {status === "loading" && (
          <div className={styles.loader} role="status" aria-live="polite">
            <span className={styles.loaderLabel}>Preparing the demonstration room</span>
            <span className={styles.loaderTrack} aria-hidden="true">
              <span ref={loaderBarRef} className={styles.loaderBar} />
            </span>
          </div>
        )}
        {status === "error" && (
          <StatusState compact status="error" {...errorCopy[error]} className={styles.error} />
        )}
        <p className={styles.caption} data-hero-caption>
          <span>Fig. 01</span>
          <span>A living room, photographed. Demonstration scene.</span>
        </p>
      </div>

      <div className={styles.title} data-hero-copy>
        <h1 className={styles.heading}>
          <span className={styles.line}>
            <span>Reimagine</span>
          </span>
          <span className={styles.line}>
            <span>your space.</span>
          </span>
        </h1>
      </div>

      <p className={styles.lede} data-hero-copy>
        One photograph becomes an editable 3D model of your room: its walls, furniture, materials and
        light.
      </p>

      <div className={styles.actions} data-hero-copy>
        <ButtonLink href={routes.workspace} size="l" arrow>
          Try it now
        </ButtonLink>
        <a className={styles.cue} href={`#${anchors.sequence}`}>
          <span>Scroll to explore</span>
          <svg viewBox="0 0 10 16" aria-hidden="true" focusable="false">
            <path d="M5 0v14.5M1 10.5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.25" />
          </svg>
        </a>
      </div>
    </div>
  );
}
