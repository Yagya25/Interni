"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { anchors } from "@/config/site";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { Material, Scene } from "@/scene/model/types";
import { agentStatus, httpAgent } from "./agent/client";
import { notConnected, type CommandInterpreter } from "./ai/interpreter";
import { ChangeProposal } from "./command/ChangeProposal";
import { CommandBar } from "./command/CommandBar";
import { DesignDirections } from "./design/DesignDirections";
import { Inspector } from "./Inspector";
import { AiPanel } from "./panels/AiPanel";
import { CameraPanel } from "./panels/CameraPanel";
import { LightingPanel } from "./panels/LightingPanel";
import { MaterialsPanel } from "./panels/MaterialsPanel";
import { ObjectsPanel } from "./panels/ObjectsPanel";
import { StageProvider, type StageHandle } from "./scene/StageContext";
import { useStage } from "./scene/useStage";
import { SourceProvider, type WorkspaceSource } from "./sourceContext";
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
  /** The photograph a reconstructed room came from. None for the demonstration room. */
  source?: WorkspaceSource;
}

/**
 * Your space.
 *
 * The room is the document; everything else is an instrument arranged
 * around it. One store holds the scene and its history, one renderer draws
 * it, and every change — dragged, typed, or one day spoken — takes the
 * same route through a scene operation.
 */
export function Workspace({ scene, name, palette, interpreter, source }: WorkspaceProps) {
  const [store] = useState(() => new WorkspaceStore(scene, name, interpreter ?? notConnected, palette));
  // The design agent is bound only when the server has one configured; otherwise
  // every request is routed exactly as before Phase 6.
  useEffect(() => {
    let live = true;
    void agentStatus().then(({ available, model }) => {
      if (live && available && model) store.setAgent({ agent: httpAgent(model), evidence: source?.evidence ?? null });
    });
    return () => {
      live = false;
      store.setAgent(null);
    };
  }, [store, source]);
  return (
    <WorkspaceProvider value={store}>
      <SourceProvider value={source ?? null}>
        <Shell />
      </SourceProvider>
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
  const designing = useWorkspace((s) => s.design !== null);

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
        {/* Marked while design directions are open, so the title block can take its place beneath them. */}
        <main id={anchors.main} tabIndex={-1} className={styles.stage} data-region="stage" data-designs={designing ? "" : undefined}>
          <Viewport canvasRef={canvasRef} viewportRef={viewportRef} />
          <DesignDirections />
          <ChangeProposal />
        </main>

        {selected && <Inspector object={selected} />}
        <CommandBar />
      </div>
    </StageProvider>
  );
}
