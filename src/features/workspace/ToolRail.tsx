"use client";

import type { ComponentType } from "react";
import { AiIcon, CameraIcon, LightingIcon, MaterialsIcon, ObjectsIcon } from "./icons";
import { useStore, useWorkspace, type ToolId } from "./state/store";
import styles from "./ToolRail.module.css";

interface Tool {
  id: ToolId;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

/**
 * Five instruments, and nothing that does not work yet.
 *
 * Measuring and floor plans belong in the rail eventually; they are not
 * here because they are not built, and a button that does nothing is worse
 * than an absence.
 */
const TOOLS: readonly Tool[] = [
  { id: "ai", label: "Ask", Icon: AiIcon },
  { id: "objects", label: "Objects", Icon: ObjectsIcon },
  { id: "materials", label: "Materials", Icon: MaterialsIcon },
  { id: "lighting", label: "Lighting", Icon: LightingIcon },
  { id: "camera", label: "Camera", Icon: CameraIcon },
];

export function ToolRail() {
  const store = useStore();
  const tool = useWorkspace((s) => s.tool);

  return (
    <nav className={styles.rail} data-region="rail" aria-label="Tools">
      <ul className={styles.list}>
        {TOOLS.map(({ id, label, Icon }) => (
          <li key={id}>
            <button
              type="button"
              className={styles.tool}
              data-on={tool === id || undefined}
              aria-pressed={tool === id}
              aria-controls={`panel-${id}`}
              onClick={() => store.setTool(id)}
            >
              <Icon className={styles.icon} />
              <span className={styles.label}>{label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
