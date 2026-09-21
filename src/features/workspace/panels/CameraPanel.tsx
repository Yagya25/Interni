"use client";

import { useEffect, useState } from "react";
import { Field, NumberField, Reading } from "../controls/Controls";
import { useStageHandle } from "../scene/StageContext";
import { useSelectedObject, useStore, useWorkspace } from "../state/store";
import { Note, Panel, Section } from "./Panel";
import styles from "./panels.module.css";

/**
 * Where you are standing, and through what lens.
 *
 * The camera is not part of the document: moving it changes nothing about
 * the room, so it is not undoable and does not belong in the history. It
 * lives in the stage's view state, which the rig is the only writer of.
 */
export function CameraPanel() {
  const store = useStore();
  const { rigRef, viewRef, stageRef } = useStageHandle();
  const scene = useWorkspace((s) => s.scene);
  const selected = useSelectedObject();
  const [fov, setFov] = useState(scene.camera.verticalFov);

  // The panel can be opened after the lens has already been changed, so it
  // reads the live value once it is mounted rather than assuming the scene's.
  useEffect(() => {
    const view = viewRef.current;
    if (view) setFov(view.camera.fov);
  }, [viewRef]);

  const setLens = (value: number) => {
    const view = viewRef.current;
    if (!view) return;
    view.camera.fov = value;
    setFov(value);
    stageRef.current?.invalidate();
  };

  return (
    <Panel
      id="panel-camera"
      title="Camera"
      summary="Named views, and the lens they are seen through."
      onClose={() => store.setTool(null)}
    >
      <Section title="Views">
        <div className={styles.presets}>
          <button
            type="button"
            className={styles.preset}
            onClick={() => rigRef.current?.goTo(rigRef.current.capture(scene))}
          >
            Photograph
          </button>
          <button
            type="button"
            className={styles.preset}
            onClick={() => rigRef.current?.goTo(rigRef.current.front())}
          >
            Front
          </button>
          <button
            type="button"
            className={styles.preset}
            onClick={() => rigRef.current?.goTo(rigRef.current.top())}
          >
            Top
          </button>
          <button
            type="button"
            className={styles.preset}
            disabled={!selected}
            onClick={() => selected && rigRef.current?.goTo(rigRef.current.frameObject(selected))}
          >
            Frame selection
          </button>
        </div>
        <dl>
          <Reading
            label="Capture"
            value={`${scene.camera.verticalFov}° vertical · ${scene.camera.aspect.toFixed(2)}:1`}
          />
        </dl>
      </Section>

      <Section title="Lens">
        <Field label="Field" note="Narrow reads like a long lens; wide takes in more of the room.">
          <NumberField
            label="Vertical field of view"
            value={fov}
            min={20}
            max={80}
            step={1}
            decimals={0}
            unit="°"
            onChange={setLens}
            onSettle={() => {}}
          />
        </Field>
      </Section>

      <Section title="Moving about">
        <Note>
          Drag to turn the room. Shift-drag, the middle button or two fingers to slide it. Scroll or
          pinch to come closer. <kbd>F</kbd> frames whatever is selected.
        </Note>
      </Section>
    </Panel>
  );
}
