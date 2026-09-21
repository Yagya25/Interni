import type { CSSProperties } from "react";
import { demo } from "@/demo";
import { findOperation } from "@/scene/model/operations";
import { findById } from "@/scene/model/queries";
import styles from "./layers.module.css";

/**
 * Readouts that belong to the frame rather than to a point in the room: a
 * scale, a clock, the tools in use, the design direction. They are set like
 * the legend of a drawing, straight onto the picture, and every value is
 * derived from the demonstration scene.
 */

const { scene, variant, operations } = demo;

export function Panels() {
  const move = findOperation(operations, "move");
  const replace = findOperation(operations, "replace");
  const restyle = findOperation(operations, "restyle");
  const label = (id?: string) => (id ? (findById(scene.objects, id)?.label ?? id) : "");
  const variantMaterials = variant.scene.materials.filter((m) =>
    ["limewash-sand", "oak-smoked", "travertine", "boucle-ivory"].includes(m.id),
  );

  return (
    <div className={styles.panels}>
      {/* Depth: what the contours mean */}
      <div className={`${styles.legend} ${styles.legendBottom}`} data-layer="depth-legend" aria-hidden="true">
        <p className={styles.legendKicker}>Distance from camera</p>
        <div className={styles.depthScale}>
          <span className={styles.depthRamp} />
          <span className={styles.depthTicks}>
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i}>{i % 2 === 0 ? `${i} m` : ""}</span>
            ))}
          </span>
        </div>
      </div>

      {/* Light: the clock that drives the sun */}
      <div className={`${styles.legend} ${styles.legendBottom}`} data-layer="time-scale" aria-hidden="true">
        <p className={styles.legendKicker}>Time of day</p>
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

      {/* Edit: the tools, each lit while it is in use. Low, where the edit
          shot has open floor, clear of the labels on the pieces being edited. */}
      <div className={`${styles.legend} ${styles.legendBottom}`} data-layer="edit-tools">
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

      {/* Reimagine: the design direction applied */}
      <section className={`${styles.legend} ${styles.legendTop}`} data-layer="variant" data-keep aria-labelledby="variant-title">
        <h3 id="variant-title" className={styles.legendKicker} data-item>
          Design direction <span className={styles.demoTag}>Demonstration</span>
        </h3>
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
