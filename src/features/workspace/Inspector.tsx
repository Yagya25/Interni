"use client";

import { findById } from "@/scene/model/queries";
import { formatMetres } from "@/scene/model/summary";
import type { SceneObject, Surface, Vec3 } from "@/scene/model/types";
import { Field, NumberField, Reading } from "./controls/Controls";
import { Panel, Section } from "./panels/Panel";
import { useStageHandle } from "./scene/StageContext";
import { moveObject, removeObject, resizeObject, rotateObject } from "./state/edits";
import { useStore, useWorkspace } from "./state/store";
import styles from "./Inspector.module.css";

/**
 * What is selected, as the model holds it.
 *
 * Every reading comes from the Scene: the label, the category, the slots,
 * the metres. Editing a reading applies an operation, so the number in the
 * field and the piece in the room can never disagree, and every change
 * here can be undone.
 */
export function Inspector({ object }: { object: SceneObject }) {
  const store = useStore();
  const scene = useWorkspace((s) => s.scene);
  const { rigRef } = useStageHandle();
  const settle = () => store.seal();

  const [px, py, pz] = object.transform.position;
  const [sx, sy, sz] = object.transform.scale;
  const [w, h, d] = object.dimensions;
  const rotation = (object.transform.rotation[1] * 180) / Math.PI;
  const support = describeSupport(object, scene.surfaces);
  /** Height is fixed by whatever carries the piece, unless it hangs. */
  const heightIsFree = object.support.kind === "wall" || object.support.kind === "ceiling";

  const moveTo = (axis: 0 | 1 | 2, value: number) => {
    const to: Vec3 = [axis === 0 ? value : px, axis === 1 ? value : py, axis === 2 ? value : pz];
    store.apply(moveObject(scene, object, to));
  };

  const resizeTo = (axis: 0 | 1 | 2, metres: number) => {
    const base = object.dimensions[axis];
    if (base <= 0) return;
    const factor = metres / base;
    const to: Vec3 = [axis === 0 ? factor : sx, axis === 1 ? factor : sy, axis === 2 ? factor : sz];
    store.apply(resizeObject(object, to));
  };

  return (
    <Panel
      id="inspector"
      side="right"
      title={object.label}
      summary={`${readable(object.category)} · ${support}`}
      onClose={() => store.select(null)}
    >
      <Section title="Identity">
        <dl>
          <Reading label="Type" value={readable(object.category)} />
          {object.form && <Reading label="Form" value={readable(object.form)} />}
          <Reading
            label="Materials"
            value={Object.entries(object.materials)
              .map(([slot, id]) => `${slot}: ${findById(scene.materials, id)?.name ?? id}`)
              .join(", ")}
          />
          <Reading
            label="Size"
            value={`${formatMetres(w * sx)} × ${formatMetres(d * sz)} × ${formatMetres(h * sy)}`}
          />
        </dl>
      </Section>

      <Section title="Placement">
        <div className={styles.stack}>
          <Field label="Across" note="X, from the room's origin">
            <NumberField
              label="Position across the room"
              value={px}
              min={-50}
              max={50}
              step={0.05}
              unit="m"
              onChange={(value) => moveTo(0, value)}
              onSettle={settle}
            />
          </Field>
          <Field label="Along" note="Z, from the room's origin">
            <NumberField
              label="Position along the room"
              value={pz}
              min={-50}
              max={50}
              step={0.05}
              unit="m"
              onChange={(value) => moveTo(2, value)}
              onSettle={settle}
            />
          </Field>
          <Field label="Height" note={heightIsFree ? undefined : `Set by what carries it — ${support}`}>
            <NumberField
              label="Height above the floor"
              value={py}
              min={0}
              max={10}
              step={0.05}
              unit="m"
              disabled={!heightIsFree}
              onChange={(value) => moveTo(1, value)}
              onSettle={settle}
            />
          </Field>
          <Field label="Turn">
            <NumberField
              label="Rotation"
              value={round1(rotation)}
              min={-180}
              max={180}
              step={5}
              decimals={1}
              unit="°"
              onChange={(value) => store.apply(rotateObject(scene, object, (value * Math.PI) / 180))}
              onSettle={settle}
            />
          </Field>
        </div>
      </Section>

      <Section title="Size">
        <div className={styles.stack}>
          <Field label="Width">
            <NumberField
              label="Width"
              value={w * sx}
              min={0.05}
              max={8}
              step={0.05}
              unit="m"
              onChange={(value) => resizeTo(0, value)}
              onSettle={settle}
            />
          </Field>
          <Field label="Depth">
            <NumberField
              label="Depth"
              value={d * sz}
              min={0.05}
              max={8}
              step={0.05}
              unit="m"
              onChange={(value) => resizeTo(2, value)}
              onSettle={settle}
            />
          </Field>
          <Field label="Height">
            <NumberField
              label="Height"
              value={h * sy}
              min={0.01}
              max={5}
              step={0.05}
              unit="m"
              onChange={(value) => resizeTo(1, value)}
              onSettle={settle}
            />
          </Field>
        </div>
      </Section>

      <Section title="Actions">
        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={() => store.setTool("materials")}>
            Materials
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={() => rigRef.current?.goTo(rigRef.current.frameObject(object))}
          >
            Frame <kbd>F</kbd>
          </button>
          <button type="button" className={styles.action} onClick={() => store.setTool("ai")}>
            Ask about this
          </button>
          <button
            type="button"
            className={styles.action}
            data-destructive
            onClick={() => store.apply(removeObject(scene, object))}
          >
            Remove <kbd>Del</kbd>
          </button>
        </div>
        <p className={styles.hint}>
          Drag the piece in the room to move it. <kbd>Esc</kbd> clears the selection.
        </p>
      </Section>
    </Panel>
  );
}

/** What holds the piece up, in the words a person would use. */
function describeSupport(object: SceneObject, surfaces: readonly Surface[]) {
  switch (object.support.kind) {
    case "floor":
      return "on the floor";
    case "ceiling":
      return "from the ceiling";
    case "wall": {
      const wallId = object.support.wallId;
      return `on the ${(surfaces.find((s) => s.id === wallId)?.label ?? "wall").toLowerCase()}`;
    }
    case "object":
      return `on the ${object.support.objectId.replace(/-/g, " ")}`;
  }
}

const readable = (value: string) => {
  const spaced = value.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const round1 = (value: number) => Number(value.toFixed(1));
