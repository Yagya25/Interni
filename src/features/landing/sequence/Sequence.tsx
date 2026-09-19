"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { anchors } from "@/config/site";
import { demo } from "@/demo";
import { useMediaQuery, useReducedMotion } from "@/lib/useReducedMotion";
import type { Id } from "@/scene/model/types";
import type { SceneStage } from "@/scene/render/SceneStage";
import { createViewState, type RevealGroup } from "@/scene/render/viewState";
import { timings, TOTAL_SPAN, VH_PER_UNIT } from "./chapters";
import { ChapterCopy } from "./layers/ChapterCopy";
import { Closing } from "./layers/Closing";
import { HeroLayer, type StageError, type StageStatus } from "./layers/HeroLayer";
import { Panels } from "./layers/Panels";
import { SceneLabels } from "./layers/SceneLabels";
import { ProgressRail } from "./ProgressRail";
import styles from "./Sequence.module.css";
import { captureShot } from "./shots";
import { useSequenceTimeline } from "./useSequenceTimeline";

const revealSeeds = Object.fromEntries(demo.materialCallouts.map((c) => [c.class, c.anchor])) as Partial<
  Record<RevealGroup, readonly [number, number, number]>
>;

/**
 * The pinned stage. The first viewport is the hero; scrolling plays the
 * film. The 3D stage is loaded lazily; the story still reads if it fails.
 */
export function Sequence() {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const loaderBarRef = useRef<HTMLSpanElement>(null);
  const stageRef = useRef<SceneStage | null>(null);

  const reducedMotion = useReducedMotion();
  const portrait = useMediaQuery("(max-aspect-ratio: 1/1)");
  const [status, setStatus] = useState<StageStatus>("loading");
  const [error, setError] = useState<StageError>("webgl");
  // Created once; the timeline animates it, the stage renders from it.
  const [view] = useState(() => {
    const state = createViewState(captureShot);
    state.time = 0.08;
    return state;
  });

  // Load and run the 3D stage -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let stage: SceneStage | null = null;
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;

    const quality =
      window.matchMedia("(max-width: 900px)").matches || (navigator.hardwareConcurrency ?? 8) <= 4
        ? "low"
        : "high";

    const fail = (kind: StageError) => (error: unknown) => {
      if (cancelled) return;
      console.error("[stage]", error);
      setError(kind);
      setStatus("error");
    };

    import("@/scene/render/SceneStage")
      .then(({ SceneStage }) => {
        if (cancelled) return;
        try {
          stage = new SceneStage({
            canvas,
            viewport,
            view,
            scene: demo.scene,
            variant: demo.variant.scene,
            operations: demo.operations,
            revealSeeds,
            quality,
            onError: fail("lost"),
          });
        } catch (error) {
          // The renderer throws when no WebGL context can be created.
          fail("webgl")(error);
          return;
        }
        stageRef.current = stage;
        stage.setFrameElement(frameRef.current);
        return stage
          .init((progress) => {
            if (loaderBarRef.current) loaderBarRef.current.style.transform = `scaleX(${Math.max(0.04, progress)})`;
          })
          .then(() => {
            if (cancelled || !stage) return;
            if (overlayRef.current) stage.bindOverlay(overlayRef.current);
            setStatus("ready");
          });
      }, fail("load"))
      .catch(fail("webgl"));

    return () => {
      cancelled = true;
      stage?.dispose();
      stageRef.current = null;
    };
  }, [view]);

  // Stop rendering while the stage is off screen ----------------------------
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(([entry]) => stageRef.current?.setActive(entry.isIntersecting));
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useSequenceTimeline({ section: sectionRef, root: stageRootRef, view, stage: stageRef, reducedMotion, portrait });

  const handleHover = useCallback((id: Id | null) => stageRef.current?.setHover(id), []);

  const at = (time: number) => `${(time * VH_PER_UNIT).toFixed(2)}vh`;

  return (
    <section
      ref={sectionRef}
      className={styles.section}
      style={{ "--sequence-length": `${TOTAL_SPAN * VH_PER_UNIT}vh` } as CSSProperties}
      aria-label="How it works"
    >
      {/* In-page targets for the navigation. */}
      <span id={anchors.sequence} className={styles.target} style={{ top: at(timings.photo.start) }} />
      <span id={anchors.reimagine} className={styles.target} style={{ top: at(timings.reimagine.settle) }} />

      <div ref={stageRootRef} className={styles.stage} data-stage-status={status}>
        <div ref={viewportRef} className={styles.viewport} data-print="hide">
          <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
          <div className={styles.grain} data-grain aria-hidden="true" />
        </div>

        <div ref={overlayRef} className={styles.overlay}>
          <HeroLayer frameRef={frameRef} loaderBarRef={loaderBarRef} status={status} error={error} />
          <SceneLabels onHover={handleHover} />
          <Panels />
          <ChapterCopy />
          <Closing />
        </div>

        <ProgressRail />
      </div>
    </section>
  );
}
