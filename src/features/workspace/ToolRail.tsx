"use client";

import type { ComponentType } from "react";
import { AiIcon, CalibrateIcon, CameraIcon, EvidenceIcon, LightingIcon, MaterialsIcon, ObjectsIcon } from "./icons";
import { useWorkspaceSource } from "./sourceContext";
import { useStore, useWorkspace, type ToolId } from "./state/store";
import styles from "./ToolRail.module.css";

interface Tool {
  id: ToolId;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

/**
 * Five instruments, and nothing that does not work yet — seven for a
 * reconstructed room, which can also show its evidence and be calibrated.
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

/** A reconstructed room also says how it is known, and can be calibrated. */
const RECONSTRUCTION_TOOLS: readonly Tool[] = [
  { id: "evidence", label: "Evidence", Icon: EvidenceIcon },
  { id: "calibrate", label: "Calibrate", Icon: CalibrateIcon },
];

export function ToolRail() {
  const store = useStore();
  const tool = useWorkspace((s) => s.tool);
  const reconstructed = !!useWorkspaceSource()?.evidence;
  const tools = reconstructed ? [...TOOLS, ...RECONSTRUCTION_TOOLS] : TOOLS;

  return (
    <nav className={styles.rail} data-region="rail" aria-label="Tools">
      <ul className={styles.list}>
        {tools.map(({ id, label, Icon }) => (
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
