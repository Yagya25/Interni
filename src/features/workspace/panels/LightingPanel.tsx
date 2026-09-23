"use client";

import { timeOfDay } from "@/scene/model/operations";
import type { ArtificialLight } from "@/scene/model/types";
import { Field, NumberField, RangeField, Reading, Segmented } from "../controls/Controls";
import { describeAmbient, describeDaylight, describeLamp } from "../reconstruction/describe";
import { useWorkspaceSource } from "../sourceContext";
import { changeLamp, setTimeOfDay } from "../state/edits";
import { useStore, useWorkspace } from "../state/store";
import { Note, Panel, Section } from "./Panel";
import styles from "./panels.module.css";

/**
 * Light.
 *
 * The hour moves a real sun: its elevation, its colour, the sky through
 * the windows, the exposure of the whole room and whether the lamps come
 * on by themselves. Each fixture can then be overruled — switched on at
 * noon, off at dusk, turned up, or warmed.
 *
 * Every control here changes the scene, not a filter over it.
 */

/**
 * The rig runs from a high midday sun to a sunless evening, so these are
 * the hours it can actually show. There is no dawn in it, and nothing here
 * pretends otherwise.
 */
const HOURS = [
  { label: "Midday", value: 0 },
  { label: "Afternoon", value: 0.45 },
  { label: "Golden hour", value: 0.68 },
  { label: "Evening", value: 0.86 },
  { label: "Night", value: 1 },
] as const;

const SWITCH = [
  { value: "auto", label: "Auto" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

export function LightingPanel() {
  const store = useStore();
  const scene = useWorkspace((s) => s.scene);
  const daylight = scene.lights.find((l) => l.kind === "daylight");
  const lamps = scene.lights.filter((l): l is ArtificialLight => l.kind === "artificial");
  const ambient = scene.lights.find((l) => l.kind === "ambient");
  const hour = timeOfDay(scene);
  const entities = useWorkspaceSource()?.evidence?.entities;
  const found = describeDaylight(daylight && entities?.[daylight.id]);
  const bounce = ambient && describeAmbient(entities?.[ambient.id]);

  return (
    <Panel
      id="panel-lighting"
      title="Lighting"
      summary="The hour of the day, and the fixtures in the room."
      onClose={() => store.setTool(null)}
    >
      <Section title="Daylight">
        {!daylight ? (
          <Note>This room has no daylight in its model, so there is no hour to set.</Note>
        ) : (
          <>
            <div className={styles.presets}>
              {HOURS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={styles.preset}
                  data-on={Math.abs(hour - preset.value) < 0.02 || undefined}
                  onClick={() => {
                    store.apply(setTimeOfDay(daylight.id, preset.value));
                    store.seal();
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <Field label="Hour" note={`${Math.round(hour * 100)} — midday to night`}>
              <RangeField
                label="Time of day"
                value={hour}
                min={0}
                max={1}
                step={0.01}
                onChange={(value) => store.apply(setTimeOfDay(daylight.id, value))}
                onSettle={() => store.seal()}
              />
            </Field>
            <dl>
              <Reading label="Through" value={`${daylight.openingIds.length} openings`} />
              {found.kind && <Reading label="As found" value={found.kind} />}
              {found.from && <Reading label="Comes from" value={found.from} />}
            </dl>
          </>
        )}
      </Section>

      {lamps.map((lamp) => (
        <Section key={lamp.id} title={lamp.label}>
          {describeLamp(entities?.[lamp.id]) && (
            <dl>
              <Reading label="As found" value={describeLamp(entities?.[lamp.id])!} />
            </dl>
          )}
          <div className={styles.stack}>
            <Field label="Switch">
              <Segmented
                label={`${lamp.label} switch`}
                value={lamp.on === undefined ? "auto" : lamp.on ? "on" : "off"}
                options={SWITCH}
                onChange={(value) => {
                  store.apply(
                    changeLamp(lamp, { on: value === "auto" ? "auto" : value === "on" }, "switch"),
                  );
                  store.seal();
                }}
              />
            </Field>
            <Field label="Output" note={lamp.on === false ? "Switched off" : undefined}>
              <NumberField
                label={`${lamp.label} output`}
                value={lamp.intensity ?? 1}
                min={0}
                max={3}
                step={0.1}
                decimals={1}
                unit="×"
                disabled={lamp.on === false}
                onChange={(intensity) => store.apply(changeLamp(lamp, { intensity }, "output"))}
                onSettle={() => store.seal()}
              />
            </Field>
            <Field label="Warmth">
              <NumberField
                label={`${lamp.label} colour temperature`}
                value={lamp.colorTemperature}
                min={1800}
                max={6500}
                step={100}
                decimals={0}
                unit="K"
                disabled={lamp.on === false}
                onChange={(colorTemperature) =>
                  store.apply(changeLamp(lamp, { colorTemperature }, "warmth"))
                }
                onSettle={() => store.seal()}
              />
            </Field>
          </div>
        </Section>
      ))}

      {ambient && (
        <Section title="Ambient">
          {bounce && (
            <dl>
              <Reading label="Colour" value={bounce} />
            </dl>
          )}
          <Note>
            The room’s bounce light. It is part of the model but is not adjustable on its own — it
            follows the hour along with everything else.
          </Note>
        </Section>
      )}
    </Panel>
  );
}
