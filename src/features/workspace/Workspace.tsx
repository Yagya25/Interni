"use client";

import { useMemo, useRef, useState } from "react";
import { anchors } from "@/config/site";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { Material, Scene } from "@/scene/model/types";
import { notConnected, type CommandInterpreter } from "./ai/interpreter";
import { ChangeProposal } from "./command/ChangeProposal";
import { CommandBar } from "./command/CommandBar";
import { Inspector } from "./Inspector";
import { AiPanel } from "./panels/AiPanel";
import { CameraPanel } from "./panels/CameraPanel";
import { LightingPanel } from "./panels/LightingPanel";
import { MaterialsPanel } from "./panels/MaterialsPanel";
import { ObjectsPanel } from "./panels/ObjectsPanel";
import { StageProvider, type StageHandle } from "./scene/StageContext";
import { useStage } from "./scene/useStage";
import { useSelectedObject, useStore, useWorkspace, WorkspaceProvider, WorkspaceStore } from "./state/store";
import { ToolRail } from "./ToolRail";
import { TopBar } from "./TopBar";
import { useShortcuts } from "./useShortcuts";
import { Viewport } from "./Viewport";
import styles from "./Workspace.module.css";

interface WorkspaceProps {
  scene: Scene;
  /** What this space is called. Editable, and not yet persisted anywhere. */
  name: string;
  /** Finishes this space can be given. */
  palette: readonly Material[];
  /** Supply one when a model is wired up. Defaults to none. */
  interpreter?: CommandInterpreter;
}

/**
 * Your space.
 *
 * The room is the document; everything else is an instrument arranged
 * around it. One store holds the scene and its history, one renderer draws
 * it, and every change — dragged, typed, or one day spoken — takes the
 * same route through a scene operation.
 */
export function Workspace({ scene, name, palette, interpreter }: WorkspaceProps) {
  const [store] = useState(() => new WorkspaceStore(scene, name, interpreter ?? notConnected, palette));
  return (
    <WorkspaceProvider value={store}>
      <Shell />
    </WorkspaceProvider>
  );
}

function Shell() {
  const store = useStore();
  const reducedMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const { stageRef, rigRef, viewRef, status, fault, progress, step, steps } = useStage({
    store,
    canvasRef,
    viewportRef,
    reducedMotion,
  });
  useShortcuts(store, rigRef);

  const handle = useMemo<StageHandle>(
    () => ({ stageRef, rigRef, viewRef, status, fault, progress, step, steps }),
    [stageRef, rigRef, viewRef, status, fault, progress, step, steps],
  );

  const tool = useWorkspace((s) => s.tool);
  const selected = useSelectedObject();

  return (
    <StageProvider value={handle}>
      <div className={styles.shell} data-inspecting={selected ? "" : undefined}>
        <TopBar />
        <ToolRail />
        {tool === "ai" && <AiPanel />}
        {tool === "objects" && <ObjectsPanel />}
        {tool === "materials" && <MaterialsPanel />}
        {tool === "lighting" && <LightingPanel />}
        {tool === "camera" && <CameraPanel />}

        {/* The room is the page's content, and where the skip link lands. */}
        <main id={anchors.main} tabIndex={-1} className={styles.stage} data-region="stage">
          <Viewport canvasRef={canvasRef} viewportRef={viewportRef} />
          <ChangeProposal />
        </main>

        {selected && <Inspector object={selected} />}
        <CommandBar />
      </div>
    </StageProvider>
  );
}
