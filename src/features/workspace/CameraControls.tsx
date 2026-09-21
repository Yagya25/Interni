"use client";

import type { ReactNode } from "react";
import {
  CaptureViewIcon,
  FrameIcon,
  FrontViewIcon,
  TopViewIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./icons";
import { useStageHandle } from "./scene/StageContext";
import { useSelectedObject, useWorkspace } from "./state/store";
import styles from "./CameraControls.module.css";

/**
 * Where you are standing.
 *
 * Six controls, no more: the three views worth naming, a way in and out,
 * and — only once something is selected — a way to go and look at it. Every
 * one of them moves the same camera rig the pointer does.
 */
export function CameraControls() {
  const { rigRef } = useStageHandle();
  const scene = useWorkspace((s) => s.scene);
  const selected = useSelectedObject();

  return (
    <div className={styles.cluster} role="group" aria-label="View">
      <div className={styles.group}>
        <Control label="Zoom in" onPress={() => rigRef.current?.dolly(-120)}>
          <ZoomInIcon />
        </Control>
        <Control label="Zoom out" onPress={() => rigRef.current?.dolly(120)}>
          <ZoomOutIcon />
        </Control>
      </div>

      <div className={styles.group}>
        <Control
          label="Frame selection"
          disabled={!selected}
          onPress={() => selected && rigRef.current?.goTo(rigRef.current.frameObject(selected))}
        >
          <FrameIcon />
        </Control>
      </div>

      <div className={styles.group}>
        <Control label="Photograph's view" onPress={() => rigRef.current?.goTo(rigRef.current.capture(scene))}>
          <CaptureViewIcon />
        </Control>
        <Control label="Front view" onPress={() => rigRef.current?.goTo(rigRef.current.front())}>
          <FrontViewIcon />
        </Control>
        <Control label="Top view" onPress={() => rigRef.current?.goTo(rigRef.current.top())}>
          <TopViewIcon />
        </Control>
      </div>
    </div>
  );
}

interface ControlProps {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}

function Control({ label, disabled, onPress, children }: ControlProps) {
  return (
    <button type="button" className={styles.control} title={label} disabled={disabled} onClick={onPress}>
      {children}
      <span className="visually-hidden">{label}</span>
    </button>
  );
}
