import type { CSSProperties } from "react";
import { demo } from "@/demo";
import { findOperation } from "@/scene/model/operations";
import { findById } from "@/scene/model/queries";
import { formatMetres } from "@/scene/model/summary";
import styles from "./layers.module.css";

/**
 * Fixed-position readouts for each chapter. They describe the demonstration
 * scene and are derived from it; nothing here is a product metric.
 */

const { scene, summary, variant, operations } = demo;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function Panels() {
  const move = findOperation(operations, "move");
  const replace = findOperation(operations, "replace");
  const restyle = findOperation(operations, "restyle");
  const label = (id?: string) => (id ? (findById(scene.objects, id)?.label ?? id) : "");
  const variantMaterials = variant.scene.materials.filter((m) =>
    ["limewash-sand", "oak-smoked", "travertine", "boucle-ivory"].includes(m.id),
  );

  const rows: [string, string][] = [
    ["Room", summary.roomLabel],
    [
      "Dimensions",
      `${summary.dimensions.width.toFixed(2)} × ${summary.dimensions.depth.toFixed(2)} × ${formatMetres(summary.dimensions.height)}`,
    ],
    ["Objects", String(summary.objects)],
    ["Surfaces", `${summary.surfaces}${summary.inferredSurfaces ? ` (${summary.inferredSurfaces} inferred)` : ""}`],
    ["Light sources", String(summary.lightSources)],
    ["Windows", String(summary.windows)],
    ["Doors", String(summary.doors)],
    ["Materials", String(summary.materials)],
    ["Relationships", String(summary.relationships)],
  ];

  return (
    <div className={styles.panels}>
      {/* 02 Depth: what the contours mean */}
      <div className={`${styles.panel} ${styles.panelBottom}`} data-layer="depth-legend" aria-hidden="true">
        <p className={styles.panelKicker}>Distance from camera</p>
        <div className={styles.depthScale}>
          <span className={styles.depthRamp} />
          <span className={styles.depthTicks}>
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i}>{i % 2 === 0 ? `${i} m` : ""}</span>
            ))}
          </span>
        </div>
      </div>

      {/* 04 Objects: counts, derived from the scene */}
      <div className={`${styles.panel} ${styles.panelBottom}`} data-layer="object-counts" data-keep>
        <p className={styles.panelKicker}>Detected in this scene</p>
        <p className={styles.counts}>
          <span>{plural(summary.objects, "object")}</span>
          <span>{plural(summary.lightSources, "light source")}</span>
          <span>{plural(summary.windows, "window")}</span>
          <span>{plural(summary.doors, "door")}</span>
        </p>
      </div>

      {/* 06 Light: the clock that drives the sun */}
      <div className={`${styles.panel} ${styles.panelBottom}`} data-layer="time-scale" aria-hidden="true">
        <p className={styles.panelKicker}>Time of day</p>
        <div className={styles.timeScale} data-time-scale>
          <span className={styles.timeTrack}>
            <span className={styles.timeFill} />
            <span className={styles.timeMarker} />
          </span>
          <span className={styles.timeStops}>
            <span>Day</span>
            <span>Afternoon</span>
            <span>Evening</span>
          </span>
        </div>
      </div>

      {/* 07 Edit: the tools, each lit while it is in use */}
      <div className={`${styles.panel} ${styles.panelTools}`} data-layer="edit-tools">
        <p className={styles.panelKicker}>Edit</p>
        <ul className={styles.tools}>
          {[
            ["move", "Move", label(move?.objectId)],
            ["replace", "Replace", label(replace?.objectId)],
            ["material", "Material", label(restyle?.objectId)],
            ["light", "Light", "Time of day"],
          ].map(([id, name, target]) => (
            <li key={id} className={styles.tool} data-tool={id}>
              <span className={styles.toolMark} aria-hidden="true" />
              <span className={styles.toolName}>{name}</span>
              <span className={styles.toolTarget}>{target}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 09 Understanding: an inspection sheet */}
      <section className={`${styles.panel} ${styles.panelSheet}`} data-layer="inspection" data-keep aria-labelledby="inspection-title">
        <header className={styles.sheetHead} data-item>
          <h3 id="inspection-title" className={styles.panelKicker}>
            AI understanding
          </h3>
          <span className={styles.demoTag}>Demonstration values</span>
        </header>
        <dl className={styles.sheet}>
          {rows.map(([term, value]) => (
            <div key={term} className={styles.sheetRow} data-item>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* 10 Reimagine: the design direction applied */}
      <section className={`${styles.panel} ${styles.panelSheet}`} data-layer="variant" data-keep aria-labelledby="variant-title">
        <header className={styles.sheetHead} data-item>
          <h3 id="variant-title" className={styles.panelKicker}>
            Design direction
          </h3>
          <span className={styles.demoTag}>Demonstration</span>
        </header>
        <p className={styles.variantName} data-item>
          {variant.name}
        </p>
        <p className={styles.variantSummary} data-item>
          {variant.summary}
        </p>
        <ul className={styles.variantSwatches} data-item>
          {variantMaterials.map((m) => (
            <li key={m.id}>
              <span className={styles.swatch} style={{ "--swatch": m.color } as CSSProperties} />
              <span>{m.name}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Always-on honesty note while the model is on screen */}
      <p className={styles.demoNote} data-layer="demo-note">
        Demonstration scene. A hand-built model, not the result of an analysis.
      </p>
    </div>
  );
}
