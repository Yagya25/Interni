import type { CSSProperties, ReactNode } from "react";
import { demo } from "@/demo";
import { findOperation } from "@/scene/model/operations";
import { findById } from "@/scene/model/queries";
import { formatMetres } from "@/scene/model/summary";
import type { Id, RelationPredicate } from "@/scene/model/types";
import styles from "./layers.module.css";

/**
 * Labels pinned to points in the 3D scene. The stage writes each label's
 * screen position directly (no React state), so they track the camera at
 * frame rate. Everything shown is read from the demo scene.
 */

const { scene, operations, materialCallouts, summary } = demo;

function Pin({ anchor, children, item = true, tone }: { anchor: string; children: ReactNode; item?: boolean; tone?: "signal" }) {
  return (
    <div className={styles.anchor} data-anchor={anchor} data-item={item ? "" : undefined} data-tone={tone}>
      <span className={styles.pin} aria-hidden="true" />
      <span className={styles.tag}>{children}</span>
    </div>
  );
}

const predicateText: Record<RelationPredicate, string> = {
  faces: "faces",
  beside: "beside",
  "in-front-of": "in front of",
  on: "on",
  under: "under",
  above: "above",
  against: "against",
  "lit-by": "lit by",
  opposite: "opposite",
};

const spanning = new Set<RelationPredicate>(["faces", "beside", "in-front-of", "against", "lit-by", "opposite"]);

const metres = (value: number) => value.toFixed(2);

export function SceneLabels({ onHover }: { onHover: (id: Id | null) => void }) {
  const move = findOperation(operations, "move");
  const replace = findOperation(operations, "replace");
  const restyle = findOperation(operations, "restyle");
  const moved = move ? findById(scene.objects, move.objectId) : undefined;
  const movedBy = move && moved ? Math.hypot(move.to[0] - moved.transform.position[0], move.to[2] - moved.transform.position[2]) : 0;
  const restyled = restyle ? findById(scene.objects, restyle.objectId) : undefined;
  const restyledFrom = restyled && restyle ? findById(scene.materials, restyled.materials[restyle.slot]) : undefined;
  const replaced = replace ? findById(scene.objects, replace.objectId) : undefined;

  return (
    <div className={styles.labels} aria-hidden="true">
      {/* 03 Structure */}
      <div className={styles.layer} data-layer="structure">
        {scene.surfaces.map((surface) => (
          <Pin key={surface.id} anchor={`surface:${surface.id}`}>
            <span className={styles.tagName}>{surface.label}</span>
            {surface.evidence === "inferred" && <span className={styles.tagMeta}>Inferred</span>}
          </Pin>
        ))}
        {scene.openings.map((opening) => (
          <Pin key={opening.id} anchor={`opening:${opening.id}`}>
            <span className={styles.tagName}>{opening.label}</span>
            <span className={styles.tagMeta}>
              {metres(opening.width)} × {metres(opening.height)}
            </span>
          </Pin>
        ))}
      </div>

      {/* 04 Objects */}
      <div className={styles.layer} data-layer="objects">
        {scene.objects.map((object, i) => {
          // Small pieces get a name only; leader lengths alternate so tags
          // around a dense group (sofa, table, lamp) don't stack.
          const small = object.dimensions[0] * object.dimensions[2] < 0.12;
          return (
            <div
              key={object.id}
              className={styles.anchor}
              data-anchor={`object:${object.id}`}
              data-item=""
              data-small={small || undefined}
              style={{ "--lead": `${12 + (i % 3) * 20}px` } as CSSProperties}
              onPointerEnter={() => onHover(object.id)}
              onPointerLeave={() => onHover(null)}
            >
              <span className={styles.pin} aria-hidden="true" />
              <span className={`${styles.tag} ${styles.tagInteractive}`}>
                <span className={styles.tagIndex}>{String(i + 1).padStart(2, "0")}</span>
                <span className={styles.tagName}>{object.label}</span>
                {!small && (
                  <span className={styles.tagMeta}>
                    {metres(object.dimensions[0])} × {metres(object.dimensions[2])}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {/* 05 Materials */}
      <div className={styles.layer} data-layer="materials">
        {materialCallouts.map((callout) => {
          const sample = scene.materials.find((m) => m.class === callout.class);
          return (
            <Pin key={callout.class} anchor={`material:${callout.class}`}>
              <span
                className={styles.swatch}
                style={{ "--swatch": sample?.color ?? "#ccc" } as CSSProperties}
              />
              <span className={styles.tagName}>{callout.label}</span>
              <span className={styles.tagMeta}>{callout.detail}</span>
            </Pin>
          );
        })}
      </div>

      {/* 06 Light */}
      <div className={styles.layer} data-layer="light">
        {scene.lights
          .filter((light) => light.kind !== "ambient")
          .map((light) => (
            <Pin key={light.id} anchor={`light:${light.id}`}>
              <span className={styles.tagName}>{light.label}</span>
              {light.kind === "artificial" && <span className={styles.tagMeta}>{light.colorTemperature} K</span>}
              {light.kind === "daylight" && <span className={styles.tagMeta}>Direct + sky</span>}
            </Pin>
          ))}
      </div>

      {/* 07 Edit readouts */}
      {move && moved && (
        <div className={styles.layer} data-layer="edit-move">
          <Pin anchor={`object:${move.objectId}`} item={false} tone="signal">
            <span className={styles.tagName}>Move</span>
            <span className={styles.tagMeta}>
              {moved.label}, {formatMetres(movedBy)}
            </span>
          </Pin>
        </div>
      )}
      {replace && replaced && (
        <div className={styles.layer} data-layer="edit-replace">
          <Pin anchor={`object:${replace.replacement.id}`} item={false} tone="signal">
            <span className={styles.tagName}>Replace</span>
            <span className={styles.tagMeta}>
              {replaced.label} → {replace.replacement.label}
            </span>
          </Pin>
        </div>
      )}
      {restyle && restyled && (
        <div className={styles.layer} data-layer="edit-material">
          <Pin anchor={`object:${restyle.objectId}`} item={false} tone="signal">
            <span className={styles.tagName}>Material</span>
            <span className={styles.swatch} style={{ "--swatch": restyledFrom?.color ?? "#ccc" } as CSSProperties} />
            <span className={styles.tagMeta}>→</span>
            <span className={styles.swatch} style={{ "--swatch": restyle.to.color } as CSSProperties} />
            <span className={styles.tagMeta}>{restyle.to.name}</span>
          </Pin>
        </div>
      )}
      <div className={styles.layer} data-layer="edit-light">
        <Pin anchor="light:daylight" item={false} tone="signal">
          <span className={styles.tagName}>Light</span>
          <span className={styles.tagMeta}>Evening → afternoon</span>
        </Pin>
      </div>

      {/* 09 Understanding: relationships and dimensions */}
      <div className={styles.layer} data-layer="relations">
        {/* Every relationship is drawn; only those that span the room are
            named, so stacked ones (on, under, above) don't pile up. */}
        {scene.relationships.filter((rel) => spanning.has(rel.predicate)).map((rel) => (
          <div key={rel.id} className={`${styles.anchor} ${styles.relation}`} data-anchor={`relation:${rel.id}`}>
            <span className={styles.relationText}>{predicateText[rel.predicate]}</span>
          </div>
        ))}
      </div>
      <div className={styles.layer} data-layer="dimensions">
        {(["width", "depth", "height"] as const).map((key) => (
          <div key={key} className={`${styles.anchor} ${styles.dimension}`} data-anchor={`dimension:${key}`}>
            <span className={styles.dimensionText}>{formatMetres(summary.dimensions[key])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
