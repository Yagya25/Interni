"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CalibrationReference } from "@/scene/compile/calibration";
import type { ReconstructionIntermediate } from "@/scene/compile/intermediate";
import {
  checkMetres,
  measureMarks,
  onPlaneReference,
  planeAt,
  planeName,
  previewCalibration,
  roomHeightReference,
  uncalibratedLength,
  type Pixel,
  type PlaneLabelMap,
} from "../reconstruction/trust/calibrate";
import { useWorkspaceSource } from "../sourceContext";
import { useStore, useWorkspace } from "../state/store";
import { RunStatus, useRunExplanation } from "./EvidenceRows";
import { Note, Panel, Section } from "./Panel";
import styles from "./trust.module.css";

type Mode = "distance" | "height";

const NONE: readonly CalibrationReference[] = [];

/**
 * Calibrating the room to one length the person knows.
 *
 * Mark two points on one flat surface in the photograph — the width of a
 * door on its wall, a floor tile, a table top — and type the real length;
 * or give the room's real height. The reference is saved with the run in
 * the compiler's own `calibration.json`, and the room is compiled again
 * from its reconstruction with it: one factor on the shared frame, so every
 * length, measurement and layout follows. Nothing is scaled piece by piece.
 */
export function CalibrationPanel() {
  const store = useStore();
  const source = useWorkspaceSource();
  const edits = useWorkspace((s) => s.doc.past.length);
  const explanation = useRunExplanation(source);
  const intermediate = source?.intermediate ?? null;
  const references = source?.evidence?.scale.references ?? NONE;
  const map = usePlaneMap(source?.planeMap, intermediate);
  const hasCeiling = !!intermediate?.world.planes.some((p) => p.role === "ceiling");

  const [mode, setMode] = useState<Mode>("distance");
  const [marks, setMarks] = useState<Pixel[]>([]);
  const [metresText, setMetresText] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const metres = Number(metresText.replace(",", "."));
  const metresProblem = metresText.trim() ? checkMetres(metres) : null;

  const marked = useMemo(
    () => (intermediate && map.status === "ready" && marks.length === 2 ? measureMarks(intermediate, map.map, marks[0], marks[1]) : null),
    [intermediate, map, marks],
  );

  const candidate: CalibrationReference | null =
    !metresText.trim() || metresProblem
      ? null
      : mode === "height"
        ? hasCeiling
          ? roomHeightReference(metres, label)
          : null
        : marked?.ok
          ? onPlaneReference(marked.plane, marks[0], marks[1], metres, label)
          : null;

  const preview = useMemo(
    () => (intermediate && candidate ? previewCalibration(intermediate, [...references, candidate]) : null),
    [intermediate, candidate, references],
  );

  if (!source?.calibrate || !intermediate) {
    return (
      <Panel id="panel-calibrate" title="Calibrate" onClose={() => store.setTool(null)}>
        <div className={styles.form} style={{ padding: "var(--space-4)" }}>
          <Note>Only a room reconstructed on this machine can be calibrated.</Note>
        </div>
      </Panel>
    );
  }

  const apply = async (next: readonly CalibrationReference[]) => {
    setBusy(true);
    setFailure(null);
    const result = await source.calibrate!(next);
    // On success the room is compiled again and this panel with it; nothing more to do here.
    if (!result.ok) {
      setFailure(result.reason);
      setBusy(false);
    }
  };

  const heightNow = intermediate && hasCeiling ? uncalibratedLength(intermediate, { kind: "room-height", metres: 1 }) : null;

  return (
    <Panel
      id="panel-calibrate"
      title="Calibrate"
      summary="One real length you know sets the scale of the whole room."
      wide
      onClose={() => store.setTool(null)}
    >
      {explanation && explanation.status === "degraded" && (
        <Section title="Reconstruction">
          <RunStatus explanation={explanation} />
        </Section>
      )}

      <Section title="A known length">
        <div className={styles.form}>
          <div className={styles.modes} role="radiogroup" aria-label="What you know">
            <button type="button" role="radio" aria-checked={mode === "distance"} className={styles.action} data-quiet={mode !== "distance" || undefined} onClick={() => setMode("distance")}>
              A distance in the photo
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "height"}
              className={styles.action}
              data-quiet={mode !== "height" || undefined}
              disabled={!hasCeiling}
              title={hasCeiling ? undefined : "The ceiling was not seen, so the room's height can't be a reference."}
              onClick={() => setMode("height")}
            >
              The room&apos;s height
            </button>
          </div>

          {mode === "distance" ? (
            <>
              <Note>
                Click the two ends of something whose real length you know, both on one flat surface: a door&apos;s width on its
                wall, a tile on the floor. The surfaces the reconstruction fitted are tinted.
              </Note>
              <MarkedPhoto
                photograph={source.photograph}
                intermediate={intermediate}
                map={map.status === "ready" ? map.map : null}
                marks={marks}
                onMark={(p) => {
                  setFailure(null);
                  setMarks((m) => (m.length >= 2 ? [p] : [...m, p]));
                }}
              />
              {map.status === "error" && <p className={styles.problem} role="alert">{map.reason}</p>}
              <p className={styles.preview} aria-live="polite" data-marks={marks.length}>
                {marks.length === 0 && "Mark the first end."}
                {marks.length === 1 && "Mark the other end."}
                {marked && !marked.ok && marked.reason}
                {marked?.ok &&
                  `On ${planeName(marked.plane, source.report ?? null)} · the reconstruction reads ${marked.estimate.toFixed(3)} m (uncalibrated)`}
              </p>
            </>
          ) : (
            <p className={styles.preview}>
              {typeof heightNow === "number" ? `The reconstruction reads the room ${heightNow.toFixed(3)} m high (uncalibrated).` : heightNow}
            </p>
          )}

          <label className={styles.inputRow}>
            <span>Real length</span>
            <input
              inputMode="decimal"
              aria-label="Real length in metres"
              placeholder={mode === "height" ? "2.60" : "0.90"}
              value={metresText}
              onChange={(e) => setMetresText(e.target.value)}
            />
            <span>m</span>
          </label>
          <label className={styles.inputRow}>
            <span>What it is</span>
            <input aria-label="What the length is" placeholder={mode === "height" ? "room height" : "door width"} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          {metresProblem && <p className={styles.problem} role="alert">{metresProblem}</p>}

          {preview && (
            <p className={styles.preview} data-preview="">
              Every length × {preview.solution.factor.toFixed(3)} ({preview.changePercent >= 0 ? "+" : ""}
              {preview.changePercent.toFixed(1)}%)
              {preview.solution.accepted.length > 1 && ` · from ${preview.solution.accepted.length} references`}
              {preview.disagree && " · the references disagree by more than 5%: the room's proportions may be off (see the field of view)."}
            </p>
          )}
          {edits > 0 && candidate && (
            <p className={styles.problem}>
              Calibrating compiles the room again from the photograph. Your {edits} edit{edits === 1 ? "" : "s"} will be discarded.
            </p>
          )}
          {failure && <p className={styles.problem} role="alert">{failure}</p>}
          <button type="button" className={styles.action} disabled={!candidate || busy} onClick={() => candidate && void apply([...references, candidate])}>
            {busy ? "Calibrating…" : "Apply calibration"}
          </button>
        </div>
      </Section>

      <Section title="This room's calibration">
        {references.length === 0 ? (
          <Note>None yet. Every length is the depth model&apos;s estimate and shares one unknown scale error.</Note>
        ) : (
          <div className={styles.form}>
            <p className={styles.preview}>
              Every length × {source.evidence?.scale.factor.toFixed(3)}, calibrated to {references.length} reference
              {references.length === 1 ? "" : "s"}.
            </p>
            <ul className={styles.refs}>
              {references.map((r, i) => (
                <li key={i} className={styles.ref}>
                  <span>
                    {r.label ?? (r.kind === "room-height" ? "Room height" : `Distance on ${r.planeId}`)}: {r.metres} m
                  </span>
                  <button type="button" className={styles.remove} disabled={busy} onClick={() => void apply(references.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className={styles.action} data-quiet="" disabled={busy} onClick={() => void apply([])}>
              Remove calibration
            </button>
            <Note>The files these replace are kept with the run.</Note>
          </div>
        )}
      </Section>
    </Panel>
  );
}

type MapState = { status: "loading" } | { status: "ready"; map: PlaneLabelMap } | { status: "error"; reason: string };

/**
 * The worker's plane label map, decoded exactly: no colour conversion, and
 * every value checked against the run's plane labels, so a decode that
 * altered a value is refused rather than trusted.
 */
function usePlaneMap(url: string | undefined, intermediate: ReconstructionIntermediate | null): MapState {
  const [state, setState] = useState<MapState>({ status: "loading" });
  useEffect(() => {
    if (!url || !intermediate) return;
    let live = true;
    const fail = (reason: string) => live && setState({ status: "error", reason });
    (async () => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return fail("This run has no plane map, so distances can't be marked. The room's height can still be used.");
      const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return fail("The plane map couldn't be read in this browser.");
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const data = new Uint8Array(bitmap.width * bitmap.height);
      const labels = new Set(intermediate.world.planes.map((p) => p.label));
      for (let i = 0; i < data.length; i++) {
        const v = rgba[i * 4];
        if (v !== 0 && !labels.has(v)) return fail("The plane map didn't decode exactly in this browser, so distances can't be marked safely.");
        data[i] = v;
      }
      const map = { width: bitmap.width, height: bitmap.height, data };
      if (map.width !== intermediate.source.width || map.height !== intermediate.source.height) return fail("The plane map doesn't match this photograph.");
      if (live) setState({ status: "ready", map });
    })().catch(() => fail("The plane map couldn't be loaded."));
    return () => {
      live = false;
    };
  }, [url, intermediate]);
  return state;
}

/** The photograph, with the fitted surfaces tinted, the surface under the first mark picked out, and the marks. */
function MarkedPhoto({
  photograph,
  intermediate,
  map,
  marks,
  onMark,
}: {
  photograph: string;
  intermediate: ReconstructionIntermediate;
  map: PlaneLabelMap | null;
  marks: readonly Pixel[];
  onMark: (p: Pixel) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { width, height } = intermediate.source;
  const first = map && marks[0] ? planeAt(intermediate, map, marks[0]) : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    if (map) {
      const tint = context.createImageData(width, height);
      for (let i = 0; i < map.data.length; i++) {
        const label = map.data[i];
        if (!label) continue;
        const picked = first && label === first.label;
        tint.data[i * 4] = picked ? 255 : 40;
        tint.data[i * 4 + 1] = picked ? 170 : 90;
        tint.data[i * 4 + 2] = picked ? 0 : 160;
        tint.data[i * 4 + 3] = picked ? 90 : label % 2 ? 34 : 18;
      }
      context.putImageData(tint, 0, 0);
    }
    const r = Math.max(4, width / 160);
    context.lineWidth = Math.max(2, width / 400);
    context.strokeStyle = "#111";
    context.fillStyle = "#fff";
    if (marks.length === 2) {
      context.beginPath();
      context.moveTo(marks[0][0], marks[0][1]);
      context.lineTo(marks[1][0], marks[1][1]);
      context.stroke();
    }
    for (const [x, y] of marks) {
      context.beginPath();
      context.arc(x, y, r, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  }, [map, marks, width, height, first]);

  return (
    <div
      className={styles.photo}
      data-calibration-photo=""
      onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        onMark([((event.clientX - box.left) / box.width) * width, ((event.clientY - box.top) / box.height) * height]);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photograph} alt="Your photograph: click two points to mark a known length" draggable={false} />
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
