"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { timeOfDay } from "@/scene/model/operations";
import { chooseQuality } from "@/scene/render/quality";
import type { SceneStage } from "@/scene/render/SceneStage";
import { createViewState, type ViewState } from "@/scene/render/viewState";
import type { WorkspaceStore } from "../state/store";
import { CameraRig } from "./camera";

export type StageStatus = "loading" | "ready" | "error";
export type StageFault = "webgl" | "load" | "lost";

/**
 * What the renderer is doing while the room is being prepared.
 *
 * These are the stage's own checkpoints, not a timer: each one is the work
 * that starts when the previous finishes. Nothing here invents a percentage
 * the renderer has not reported.
 */
const STEPS = [
  { from: 0, label: "Reading the model" },
  { from: 0.05, label: "Drawing materials" },
  { from: 0.3, label: "Building the room" },
  { from: 0.45, label: "Placing objects" },
  { from: 0.7, label: "Setting the light" },
  { from: 0.8, label: "Compiling shaders" },
] as const;

const stepAt = (progress: number) => {
  let index = 0;
  for (let i = 0; i < STEPS.length; i += 1) if (progress >= STEPS[i].from) index = i;
  return index;
};

interface Options {
  store: WorkspaceStore;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  reducedMotion: boolean;
}

/**
 * Mounts the existing SceneStage into the workspace and keeps it pointed at
 * the store's scene.
 *
 * The bridge is deliberately imperative: the store is subscribed to outside
 * React, so an edit repaints the room without re-rendering a single
 * component. React hears about the stage only when it starts, fails, or
 * finishes.
 */
export function useStage({ store, canvasRef, viewportRef, reducedMotion }: Options) {
  const stageRef = useRef<SceneStage | null>(null);
  const rigRef = useRef<CameraRig | null>(null);
  const viewRef = useRef<ViewState | null>(null);

  const [status, setStatus] = useState<StageStatus>("loading");
  const [fault, setFault] = useState<StageFault>("webgl");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let stage: SceneStage | null = null;
    let rig: CameraRig | null = null;
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;

    const scene = store.getState().doc.scene;
    // The workspace is the room full-bleed, not a photograph composed inside
    // a frame, so the stage starts where the landing page's story ends up.
    const view = createViewState({
      px: scene.camera.position[0],
      py: scene.camera.position[1],
      pz: scene.camera.position[2],
      tx: scene.camera.target[0],
      ty: scene.camera.target[1],
      tz: scene.camera.target[2],
      fov: scene.camera.verticalFov,
    });
    view.frame = 0;
    view.time = timeOfDay(scene);
    // In the editor the pointer always picks things out; in the story it
    // only does so where the timeline asks.
    view.hover = 1;
    viewRef.current = view;

    const fail = (kind: StageFault) => (error: unknown) => {
      if (cancelled) return;
      console.error("[workspace]", error);
      setFault(kind);
      setStatus("error");
    };

    const quality = chooseQuality();

    import("@/scene/render/SceneStage")
      .then(({ SceneStage: Stage }) => {
        if (cancelled) return;
        try {
          stage = new Stage({ canvas, viewport, view, scene, quality, onError: fail("lost") });
        } catch (error) {
          // The renderer throws when no WebGL context can be created.
          fail("webgl")(error);
          return;
        }
        stageRef.current = stage;
        rig = new CameraRig(view, scene, () => stage?.invalidate(), { reducedMotion });
        rigRef.current = rig;

        return stage.init((value) => !cancelled && setProgress(value)).then(() => {
          if (cancelled) return;
          setStatus("ready");
        });
      }, fail("load"))
      .catch(fail("webgl"));

    return () => {
      cancelled = true;
      rig?.dispose();
      stage?.dispose();
      rigRef.current = null;
      stageRef.current = null;
      viewRef.current = null;
    };
    // Mounted once for the life of the workspace: the scene that follows is
    // delivered by `syncScene`, never by rebuilding the renderer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // The scene is the source of truth; the stage is told, not asked. ---------
  useEffect(
    () =>
      store.subscribe(() => {
        const stage = stageRef.current;
        const view = viewRef.current;
        if (!stage || !view) return;
        const { scene, selection } = store.getState();
        view.time = timeOfDay(scene);
        stage.syncScene(scene);
        stage.setSelection(selection);
        stage.invalidate();
      }),
    [store],
  );

  useEffect(() => {
    rigRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  // Nothing to draw for a tab nobody is looking at. -------------------------
  useEffect(() => {
    const onVisibility = () => stageRef.current?.setActive(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return {
    stageRef,
    rigRef,
    viewRef,
    status,
    fault,
    progress,
    step: stepAt(progress),
    steps: STEPS,
  };
}
