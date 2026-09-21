"use client";

import { formatMetres, summarizeScene } from "@/scene/model/summary";
import { useWorkspace } from "./state/store";
import styles from "./SceneTitleBlock.module.css";

/**
 * The title block, in the corner of the drawing where an architect would
 * put one.
 *
 * Every figure is derived from the scene being rendered, so it cannot drift
 * from what is on screen: move a sofa and the count stays right, delete it
 * and the count falls. A scene that was not measured says so.
 */
export function SceneTitleBlock() {
  const scene = useWorkspace((s) => s.scene);
  const summary = summarizeScene(scene);
  const { width, depth, height } = summary.dimensions;

  return (
    <dl className={styles.block}>
      <div className={styles.row}>
        <dt>Room</dt>
        <dd>{summary.roomLabel}</dd>
      </div>
      <div className={styles.row}>
        <dt>Extent</dt>
        <dd>
          {formatMetres(width)} × {formatMetres(depth)} × {formatMetres(height)}
        </dd>
      </div>
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
