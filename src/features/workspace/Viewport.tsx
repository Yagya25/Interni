"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/Button";
import { StatusState } from "@/components/StatusState";
import { findById } from "@/scene/model/queries";
import { CameraControls } from "./CameraControls";
import { SceneTitleBlock } from "./SceneTitleBlock";
import { attachGestures } from "./scene/gestures";
import {
  beginMove,
  beginTurn,
  grips,
  planeFor,
  positionFrom,
  ringPlaneFor,
  rotationFrom,
  type Grip,
} from "./scene/dragging";
import { useStageHandle } from "./scene/StageContext";
import { moveObject, rotateObject } from "./state/edits";
import { useStore } from "./state/store";
import styles from "./Viewport.module.css";

interface Props {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
}

/**
 * The room.
 *
 * Everything a person does here goes the same way round: the pointer asks
 * the renderer what it is over, the answer becomes an operation, the
 * operation changes the scene, and the scene is what gets drawn. The
 * component never moves a mesh itself, which is why undo can always put it
 * back and why the language model will be able to do the same things.
 */
export function Viewport({ canvasRef, viewportRef }: Props) {
  const store = useStore();
  const { stageRef, rigRef, status, fault, progress, step, steps } = useStageHandle();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gripRef = useRef<Grip | null>(null);
  const hoverFrame = useRef(0);
  /** What the pointer is over, for the cursor alone. */
  const [over, setOver] = useState<"piece" | "ring" | null>(null);
  const [gesture, setGesture] = useState<Grip["mode"] | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || status !== "ready") return;

    const objectAt = (x: number, y: number) => {
      const stage = stageRef.current;
      const id = stage?.pick(x, y) ?? null;
      if (!id) return null;
      return findById(store.getState().scene.objects, id) ?? null;
    };

    /** The ring, when the selected piece has one under this pointer. */
    const ringGrip = (x: number, y: number) => {
      const stage = stageRef.current;
      const { scene, selection } = store.getState();
      const selected = selection ? findById(scene.objects, selection) : null;
      const plane = selected && ringPlaneFor(selected);
      if (!stage || !selected || !plane) return null;
      const at = stage.pointOnPlane(x, y, plane.origin, plane.normal);
      return at && grips(selected, at) ? beginTurn(selected, at) : null;
    };

    const detach = attachGestures(root, {
      onPress(x, y) {
        const stage = stageRef.current;
        if (!stage) return false;

        // The ring is tested first: it lies partly outside the piece it
        // belongs to, over floor that would otherwise orbit the room.
        const turn = ringGrip(x, y);
        if (turn) {
          gripRef.current = turn;
          setGesture("turn");
          return true;
        }

        const object = objectAt(x, y);
        if (!object) return false;
        store.select(object.id);
        const plane = planeFor(store.getState().scene, object);
        const at = plane && stage.pointOnPlane(x, y, plane.origin, plane.normal);
        const grip = at && beginMove(store.getState().scene, object, at);
        if (!grip) return false;
        gripRef.current = grip;
        setGesture("move");
        return true;
      },

      onDragMove(x, y, shiftKey) {
        const grip = gripRef.current;
        const stage = stageRef.current;
        if (!grip || !stage) return;
        const at = stage.pointOnPlane(x, y, grip.origin, grip.normal);
        if (!at) return;
        const scene = store.getState().doc.scene;
        const object = findById(scene.objects, grip.objectId);
        if (!object) return;
        store.apply(
          grip.mode === "turn"
            ? rotateObject(scene, object, rotationFrom(grip, at, shiftKey))
            : moveObject(scene, object, positionFrom(grip, at)),
        );
      },

      onDragEnd() {
        gripRef.current = null;
        setGesture(null);
        // The gesture was one thing to undo, however many frames it took.
        store.seal();
      },

      onTap(x, y) {
        // A tap on the ring is a miss, not a request to deselect the very
        // piece the ring belongs to.
        if (ringGrip(x, y)) return;
        store.select(objectAt(x, y)?.id ?? null);
      },

      onOrbit: (dx, dy) => rigRef.current?.orbit(dx, dy),
      onPan: (dx, dy) => rigRef.current?.pan(dx, dy, root.clientHeight),
      onDolly: (notches) => rigRef.current?.dolly(notches),

      onHover(x, y) {
        // One cast per frame at most: a raycast is cheap, a raycast per
        // mouse event on a 120 Hz trackpad is not.
        if (hoverFrame.current) return;
        hoverFrame.current = requestAnimationFrame(() => {
          hoverFrame.current = 0;
          if (ringGrip(x, y)) {
            stageRef.current?.setHover(null);
            setOver("ring");
            return;
          }
          const id = stageRef.current?.pick(x, y) ?? null;
          stageRef.current?.setHover(id);
          setOver(id ? "piece" : null);
        });
      },

      onHoverEnd() {
        cancelAnimationFrame(hoverFrame.current);
        hoverFrame.current = 0;
        stageRef.current?.setHover(null);
        setOver(null);
      },
    });

    return () => {
      detach();
      cancelAnimationFrame(hoverFrame.current);
      hoverFrame.current = 0;
    };
  }, [store, stageRef, rigRef, status]);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-over={gesture ? undefined : (over ?? undefined)}
      data-gesture={gesture ?? undefined}
    >
      <div ref={viewportRef} className={styles.viewport}>
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      </div>

      {status === "loading" && (
        <div className={styles.overlay}>
          <div className={styles.loading} role="status" aria-live="polite">
            <p className={styles.loadingTitle}>Preparing space</p>
            <ol className={styles.loadingSteps}>
              {steps.map((entry, index) => (
                <li key={entry.label} data-state={index < step ? "done" : index === step ? "now" : "next"}>
                  {entry.label}
                </li>
              ))}
            </ol>
            <span className={styles.loadingBar} aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.max(0.03, progress)})` }} />
            </span>
          </div>
        </div>
      )}

      {status === "error" && (
        <div className={styles.overlay}>
          <StatusState
            className={styles.failure}
            status="error"
            kicker="3D unavailable"
            title={FAULTS[fault].title}
            description={<p>{FAULTS[fault].detail}</p>}
            action={
              fault === "webgl" ? undefined : (
                <Button variant="line" onClick={() => window.location.reload()}>
                  Try again
                </Button>
              )
            }
          />
        </div>
      )}

      {status === "ready" && (
        <>
          <SceneTitleBlock />
          <CameraControls />
        </>
      )}
    </div>
  );
}

/** Plain language. The real error goes to the console, not to the person. */
const FAULTS = {
  webgl: {
    title: "This browser can't show the room in 3D.",
    detail:
      "The workspace needs WebGL. It is usually turned off with hardware acceleration — switching that back on in the browser's settings is enough.",
  },
  load: {
    title: "The workspace didn't finish loading.",
    detail: "Part of the 3D view failed to arrive. The connection is the usual cause.",
  },
  lost: {
    title: "The 3D view was interrupted.",
    detail:
      "The browser reclaimed the graphics context, which normally happens when the machine is under load or has just woken up.",
  },
} as const;
