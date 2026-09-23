"use client";

import { useMemo, useState } from "react";
import { findById } from "@/scene/model/queries";
import type { Hex, Material, MaterialClass } from "@/scene/model/types";
import { ColorField, Field, NumberField, Swatch } from "../controls/Controls";
import { describeFinish } from "../reconstruction/describe";
import { useWorkspaceSource } from "../sourceContext";
import { adjustSlot, adjustSurface, restyleSlot, resurface, type Intent } from "../state/edits";
import { useSelectedObject, useStore, useWorkspace } from "../state/store";
import { Note, Panel, Section } from "./Panel";
import styles from "./panels.module.css";

/**
 * Finishes.
 *
 * With nothing selected the panel is about the room — its floor, walls and
 * ceiling. Select a piece and it becomes about that piece's slots instead.
 * Either way the same two moves are available: choose a finish from the
 * palette, or adjust the one that is there.
 *
 * Choosing is shared — painting a wall "chalk white" paints it with the
 * same paint the other walls use. Adjusting is not: it forks a finish that
 * belongs to the one surface being adjusted, which is why changing the
 * sofa's colour leaves the cushions alone.
 */
export function MaterialsPanel() {
  const store = useStore();
  const scene = useWorkspace((s) => s.scene);
  const object = useSelectedObject();

  const subjects = useMemo(() => {
    if (object) {
      return Object.keys(object.materials).map((slot) => ({
        key: slot,
        label: slot.charAt(0).toUpperCase() + slot.slice(1),
        materialId: object.materials[slot],
      }));
    }
    return scene.surfaces.map((surface) => ({
      key: surface.id,
      label: surface.label,
      materialId: surface.materialId,
    }));
  }, [object, scene.surfaces]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active = subjects.find((s) => s.key === activeKey) ?? subjects[0];
  const current = active ? findById(scene.materials, active.materialId) : undefined;
  const evidence = useWorkspaceSource()?.evidence;
  const found = current ? describeFinish(current, evidence?.entities[current.id]) : null;

  const change = (to: Material): Intent | null => {
    if (!active) return null;
    if (object) return restyleSlot(object, active.key, to);
    const surface = findById(scene.surfaces, active.key);
    return surface ? resurface(surface, to) : null;
  };

  const tweak = (edit: Partial<Material>, what: string): Intent | null => {
    if (!active || !current) return null;
    if (object) return adjustSlot(object, active.key, current, edit, what);
    const surface = findById(scene.surfaces, active.key);
    return surface ? adjustSurface(surface, current, edit, what) : null;
  };

  const run = (intent: Intent | null) => intent && store.apply(intent);

  return (
    <Panel
      id="panel-materials"
      title="Materials"
      summary={
        object
          ? `${object.label} — ${subjects.length} ${subjects.length === 1 ? "slot" : "slots"}.`
          : "The room's own surfaces. Select a piece to work on its finishes."
      }
      onClose={() => store.setTool(null)}
    >
      <ul className={styles.rows}>
        {subjects.map((subject) => {
          const material = findById(scene.materials, subject.materialId);
          return (
            <li key={subject.key}>
              <button
                type="button"
                className={styles.row}
                data-on={active?.key === subject.key || undefined}
                onClick={() => setActiveKey(subject.key)}
              >
                {material && <Swatch material={material} size="s" />}
                <span className={styles.rowName}>{subject.label}</span>
                <span className={styles.rowMeta}>{material?.class}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {!current ? (
        <Section title="Finish">
          <Note>This surface has no material in the model.</Note>
        </Section>
      ) : (
        <>
          <Section title="Finish">
            <div className={styles.current}>
              <Swatch material={current} />
              <span className={styles.currentName}>
                {current.name}
                <span className={styles.currentMeta}>
                  {current.class} · {current.pattern}
                </span>
              </span>
            </div>
            {found && <Note>Found in your photograph: {found}.</Note>}
            <Palette
              palette={store.palette}
              currentId={current.id}
              onPick={(material) => run(change(material))}
            />
          </Section>

          <Section title="Adjust">
            <div className={styles.stack}>
              <Field label="Colour">
                <ColorField
                  label="Colour"
                  value={current.color}
                  onChange={(color) => run(tweak({ color: color as Hex }, "colour"))}
                  onSettle={() => store.seal()}
                />
              </Field>
              <Field label="Roughness">
                <NumberField
                  label="Roughness"
                  value={current.roughness}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(roughness) => run(tweak({ roughness }, "roughness"))}
                  onSettle={() => store.seal()}
                />
              </Field>
              <Field label="Metalness">
                <NumberField
                  label="Metalness"
                  value={current.metalness}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(metalness) => run(tweak({ metalness }, "metalness"))}
                  onSettle={() => store.seal()}
                />
              </Field>
            </div>
          </Section>
        </>
      )}
    </Panel>
  );
}

/** The library, grouped the way a sample board would be. */
function Palette({
  palette,
  currentId,
  onPick,
}: {
  palette: readonly Material[];
  currentId: string;
  onPick: (material: Material) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<MaterialClass, Material[]>();
    for (const material of palette) {
      const list = groups.get(material.class) ?? [];
      list.push(material);
      groups.set(material.class, list);
    }
    return [...groups.entries()];
  }, [palette]);

  return (
    <div>
      {grouped.map(([className, materials]) => (
        <div key={className}>
          <p className={styles.paletteClass}>{className}</p>
          <div className={styles.palette}>
            {materials.map((material) => (
              <button
                key={material.id}
                type="button"
                className={styles.chip}
                data-on={material.id === currentId || undefined}
                style={{ background: material.color }}
                title={material.name}
                onClick={() => onPick(material)}
              >
                <span className="visually-hidden">{material.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
