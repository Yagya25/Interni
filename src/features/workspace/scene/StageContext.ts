"use client";

import { createContext, useContext, type RefObject } from "react";
import type { SceneStage } from "@/scene/render/SceneStage";
import type { ViewState } from "@/scene/render/viewState";
import type { CameraRig } from "./camera";
import type { StageFault, StageStatus } from "./useStage";

/**
 * A handle on the running stage, for the few places that need to reach the
 * renderer imperatively: the viewport's pointer handling and the camera
 * controls. Everything else changes the room by applying an operation.
 */
export interface StageHandle {
  stageRef: RefObject<SceneStage | null>;
  rigRef: RefObject<CameraRig | null>;
  viewRef: RefObject<ViewState | null>;
  status: StageStatus;
  fault: StageFault;
  progress: number;
  step: number;
  steps: readonly { readonly from: number; readonly label: string }[];
}

const StageContext = createContext<StageHandle | null>(null);
export const StageProvider = StageContext.Provider;

export function useStageHandle(): StageHandle {
  const handle = useContext(StageContext);
  if (!handle) throw new Error("useStageHandle must be used inside a StageProvider");
  return handle;
}
