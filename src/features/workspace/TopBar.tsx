"use client";

import Link from "next/link";
import { useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { routes, site } from "@/config/site";
import type { Scene } from "@/scene/model/types";
import { RedoIcon, UndoIcon } from "./icons";
import { useCanRedo, useCanUndo, useStore, useWorkspace } from "./state/store";
import styles from "./TopBar.module.css";

/**
 * Quiet by design. It carries what the room is called, the two controls
 * that undo a mistake, and the one thing this build can genuinely hand
 * back: the structured scene itself.
 *
 * Saving and sharing are not here because there is nowhere yet to save or
 * share to. They arrive with the reconstruction service.
 */
export function TopBar() {
  const store = useStore();
  const name = useWorkspace((s) => s.doc.name);
  const scene = useWorkspace((s) => s.doc.scene);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();

  return (
    <header className={styles.bar} data-region="top">
      <div className={styles.left}>
        <Link href={routes.home} className={styles.brand} aria-label={`${site.name}, home`}>
          <Wordmark />
        </Link>
        <span className={styles.divider} aria-hidden="true" />
        <Link href={routes.workspace} className={styles.back}>
          Change space
        </Link>
      </div>

      <RoomName name={name} onRename={(value) => store.rename(value)} />

      <div className={styles.right}>
        <div className={styles.history} role="group" aria-label="History">
          <button
            type="button"
            className={styles.step}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            onClick={() => store.undo()}
          >
            <UndoIcon />
            <span className="visually-hidden">Undo</span>
          </button>
          <button
            type="button"
            className={styles.step}
            disabled={!canRedo}
            title="Redo (Ctrl+Shift+Z)"
            onClick={() => store.redo()}
          >
            <RedoIcon />
            <span className="visually-hidden">Redo</span>
          </button>
        </div>

        <button type="button" className={styles.action} onClick={() => downloadScene(scene, name)}>
          Export model
        </button>
      </div>
    </header>
  );
}

/** The room's name, editable in place. Committed on blur or Enter. */
function RoomName({ name, onRename }: { name: string; onRename: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    const value = draft?.trim();
    setDraft(null);
    if (value) onRename(value);
  };

  return (
    <div className={styles.centre}>
      <input
        className={styles.name}
        value={draft ?? name}
        aria-label="Name of this space"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setDraft(name)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

/**
 * The scene, as the structured model it is. This is the whole asset: walls,
 * openings, objects, materials, lights and relationships, in metres.
 */
function downloadScene(scene: Scene, name: string) {
  const file = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "space"}.scene.json`;
  link.click();
  URL.revokeObjectURL(url);
}
