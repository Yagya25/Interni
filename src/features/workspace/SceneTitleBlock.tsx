"use client";

import { useEffect, useRef } from "react";
import { formatMetres, summarizeScene } from "@/scene/model/summary";
import { CIRCULATION } from "./design/layout";
import { formatMeasurement, formatSeries, measureScene, type RoomMeasurements } from "./measure";
import { useWorkspaceSource } from "./sourceContext";
import { useWorkspace } from "./state/store";
import { useSettled } from "./useSettled";
import styles from "./SceneTitleBlock.module.css";

/**
 * The block's height, published on the stage as `--title-block-space` (its
 * height plus a gap, or 0 when it is not shown), so what shares the stage's
 * left edge — the design directions — can stop above it rather than cover it.
 */
function useReportedHeight() {
  const ref = useRef<HTMLDListElement>(null);
  useEffect(() => {
    const block = ref.current;
    const stage = block?.closest<HTMLElement>('[data-region="stage"]');
    if (!block || !stage) return;
    const report = () => {
      const height = block.offsetHeight;
      stage.style.setProperty("--title-block-space", height > 0 ? `calc(${height}px + var(--space-3))` : "0px");
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(block);
    return () => {
      observer.disconnect();
      stage.style.removeProperty("--title-block-space");
    };
  }, []);
  return ref;
}

/**
 * The title block, in the corner of the drawing where an architect would
 * put one.
 *
 * Every figure is derived from the scene being rendered, so it cannot drift
 * from what is on screen: move a sofa and the count stays right, delete it
 * and the count falls. A scene that was not measured says so.
 *
 * A reconstructed room's sizes are shown no finer than they are known (see
 * `measure/`), and its floor is given two ways that are not the same thing:
 * the free floor no piece stands on, and the circulation area a path can
 * run through. Those are measured on the room once it comes to rest.
 */
export function SceneTitleBlock() {
  const scene = useWorkspace((s) => s.scene);
  const source = useWorkspaceSource();
  const summary = summarizeScene(scene);
  const { width, depth, height } = summary.dimensions;
  const ref = useReportedHeight();
  const settled = useSettled(scene);
  const measured = source ? measureScene(settled.value, source.evidence) : null;
  const caveat = measured && roomCaveat(measured.room);
  const floor = measured?.floor;

  return (
    <dl ref={ref} className={styles.block}>
      {source && (
        <div className={styles.row} data-photo>
          <dt>Photo</dt>
          <dd>
            {/* The person's own photograph, served from this machine. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={source.photograph} alt="The photograph this room was reconstructed from" />
          </dd>
        </div>
      )}
      <div className={styles.row}>
        <dt>Room</dt>
        <dd>{summary.roomLabel}</dd>
      </div>
      <div className={styles.row}>
        <dt>Extent</dt>
        <dd>
          {measured
            ? formatSeries([measured.room.width, measured.room.depth, measured.room.height])
            : `${formatMetres(width)} × ${formatMetres(depth)} × ${formatMetres(height)}`}
          {source && (
            <span className={styles.qualifier}>
              {source.scale === "calibrated" ? "calibrated to your measurement" : "estimated, not calibrated"}
            </span>
          )}
          {caveat && <span className={styles.qualifier}>{caveat}</span>}
          {source?.calibrationProblem && (
            <span className={styles.qualifier} data-problem>
              The run’s calibration couldn’t be used: {source.calibrationProblem}
            </span>
          )}
        </dd>
      </div>
      {floor && (
        <div className={styles.row} data-settling={settled.settling || undefined}>
          <dt>Floor</dt>
          <dd>
            {formatMeasurement(floor.free)} free · {formatMeasurement(floor.circulation)} circulation
            <span className={styles.qualifier}>
              free: not under furniture · circulation: where a {Math.round(CIRCULATION.clearance * 200)} cm path can run
              {floor.circulationFrom === "passage" ? " from the doorway" : ""}
            </span>
            {floor.free.available && floor.free.edited && <span className={styles.qualifier}>measured on the room as edited</span>}
          </dd>
        </div>
      )}
      <div className={styles.row}>
        <dt>Contents</dt>
        <dd>
          {summary.objects} objects · {summary.lightSources} lights · {summary.materials} materials
        </dd>
      </div>
      <div className={styles.row} data-provenance>
        <dt>Source</dt>
        <dd>
          {scene.provenance.kind === "demo"
            ? "Demonstration scene — not measured"
            : `Reconstruction ${scene.provenance.pipelineVersion}`}
        </dd>
      </div>
    </dl>
  );
}

/** What the room's extent cannot claim: a side or the ceiling that was not seen. */
function roomCaveat(room: RoomMeasurements): string | null {
  const parts = (["width", "depth", "height"] as const).flatMap((axis) => {
    const m = room[axis];
    if (!m.available) return [`${axis} unknown`];
    const unseen = axis === "height" ? "the ceiling was not seen" : "a side of the room was not seen";
    if (m.bound === "at-least") return [`${axis} at least this: ${unseen}`];
    if (m.basis === "default") return [`${axis} is a stated default: ${unseen}`];
    if (m.basis === "inferred") return [`${axis} inferred: ${unseen}`];
    return [];
  });
  return parts.length ? parts.join(" · ") : null;
}
