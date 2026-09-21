"use client";

import { formatMetres } from "@/scene/model/summary";
import { useStore, useWorkspace } from "../state/store";
import { Note, Panel } from "./Panel";
import styles from "./panels.module.css";

/**
 * Everything standing in the room, as the model knows it.
 *
 * The list is the scene's own order — the order a reconstruction would
 * return — rather than a sorted view, so what is here is exactly what the
 * model holds.
 */
export function ObjectsPanel() {
  const store = useStore();
  const objects = useWorkspace((s) => s.scene.objects);
  const selection = useWorkspace((s) => s.selection);

  return (
    <Panel
      id="panel-objects"
      title="Objects"
      summary={`${objects.length} pieces the model has separated from the room.`}
      onClose={() => store.setTool(null)}
    >
      {objects.length === 0 ? (
        <div className={styles.section}>
          <Note>Nothing is left in the room. Undo brings it back.</Note>
        </div>
      ) : (
        <ul className={styles.rows}>
          {objects.map((object) => {
            const [w, , d] = object.dimensions;
            const [sx, , sz] = object.transform.scale;
            return (
              <li key={object.id}>
                <button
                  type="button"
                  className={styles.row}
                  data-on={selection === object.id || undefined}
                  onClick={() => store.select(object.id)}
                >
                  <span className={styles.rowName}>{object.label}</span>
                  <span className={styles.rowMeta}>
                    {formatMetres(w * sx)} × {formatMetres(d * sz)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
