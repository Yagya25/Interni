import type { RefObject } from "react";
import { StatusState } from "@/components/StatusState";
import { anchors } from "@/config/site";
import { RoomWireframe } from "./RoomWireframe";
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

/**
 * The cover is a photograph and one sentence. The picture is held in a
 * paper margin, like a print; scrolling dissolves the margin and the
 * picture starts to become a room.
 */
export function HeroLayer({ frameRef, loaderBarRef, status, error = "webgl" }: HeroLayerProps) {
  return (
    <div className={styles.hero}>
      {/* The photograph is composed into this box. It never moves, so the
          stage can measure it at any scroll position. */}
      <div ref={frameRef} className={styles.frame} data-status={status}>
        {/* Stands in for the render until it arrives, and fades out under it. */}
        {status !== "ready" && <RoomWireframe />}
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
      </div>

      <div className={styles.copy} data-hero-copy>
        <h1 className={styles.heading}>
          <span className={styles.eyebrow}>Your space</span>{" "}
          <span className={styles.line}>
            <span>isn’t just</span>
          </span>{" "}
          <span className={styles.line}>
            <span>an image.</span>
          </span>
        </h1>
      </div>

      <div className={styles.margin}>
        <a className={styles.cue} href={`#${anchors.sequence}`} data-hero-copy>
          <span className={styles.cueLine} aria-hidden="true" />
          <span>Scroll</span>
        </a>
        <p className={styles.caption} data-hero-caption>
          <span>Fig. 01</span>
          <span>A living room, photographed. Demonstration scene.</span>
        </p>
      </div>
    </div>
  );
}
