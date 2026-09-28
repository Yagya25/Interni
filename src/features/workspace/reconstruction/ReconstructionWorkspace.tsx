"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ButtonLink } from "@/components/Button";
import { StatusState } from "@/components/StatusState";
import { routes } from "@/config/site";
import { createRoomInterpreter } from "../ai/roomInterpreter";
import { Workspace } from "../Workspace";
import { saveCalibration } from "./calibrationClient";
import { loadRun, problemCopy, recompile, runFileUrl, type RunState } from "./loadRun";
import styles from "./Reconstruction.module.css";

const INDEX = `${routes.workspace}/reconstruction`;

/**
 * A reconstructed room, opened in the existing workspace.
 *
 * Nothing on this page is authored: the room is compiled, in this browser,
 * from what the worker observed in the person's photograph, and the
 * photograph shown beside it is that photograph. When the run failed, the
 * page says why instead of showing any room at all.
 */
export function ReconstructionWorkspace({ runId }: { runId: string }) {
  const [state, setState] = useState<RunState>({ status: "loading" });
  /** Set once the room has been calibrated here, so it reopens with the calibration in view. */
  const [calibrated, setCalibrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadRun(runId)
      .then((next) => !cancelled && setState(next))
      .catch((error) => {
        console.error("[reconstruction]", error);
        if (!cancelled) setState({ status: "unavailable", code: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  /**
   * Calibrating is saving the references with the run, then compiling the
   * room again from the same reconstruction with them — the compiler's own
   * deterministic path, so every length, measurement and layout follows from
   * one factor on the shared frame. Nothing is rescaled piece by piece.
   */
  const calibrate = useCallback(
    async (references: Parameters<typeof saveCalibration>[1]) => {
      if (state.status !== "compiled") return { ok: false as const, reason: "The room isn't open." };
      const saved = await saveCalibration(runId, references);
      if (!saved.ok) return saved;
      setCalibrated(true);
      setState(recompile(state, saved.references));
      return { ok: true as const };
    },
    [runId, state],
  );

  // The room interpreter holds the scene as compiled, so "reset the room" returns to what the photograph gave.
  const interpreter = useMemo(
    () => (state.status === "compiled" && state.result.ok ? createRoomInterpreter(state.result.scene) : undefined),
    [state],
  );

  if (state.status === "compiled" && state.result.ok) {
    const { scene, evidence } = state.result;
    return (
      <Workspace
        // A new calibration is a new room: remount rather than diff the shell.
        key={`${scene.id}@${evidence.scale.factor}`}
        scene={scene}
        name={scene.room.label}
        palette={scene.materials}
        interpreter={interpreter}
        initialTool={calibrated ? "calibrate" : undefined}
        source={{
          photograph: runFileUrl(runId, "source.jpg"),
          scale: evidence.scale.basis,
          evidence,
          calibrationProblem: state.calibrationProblem,
          report: state.result.report,
          intermediate: state.intermediate,
          planeMap: runFileUrl(runId, "planes.png"),
          calibrate,
        }}
      />
    );
  }

  const code =
    state.status === "compiled" && !state.result.ok
      ? state.result.problem.code
      : state.status === "failed" || state.status === "unavailable"
        ? state.code
        : null;
  const copy = code ? problemCopy(code) : null;

  return (
    <div className={styles.page}>
      {copy ? (
        <StatusState
          status="error"
          kicker="Reconstruction"
          title={copy.title}
          description={<p>{copy.detail}</p>}
          action={
            <ButtonLink href={INDEX} variant="line" arrow>
              All local reconstructions
            </ButtonLink>
          }
        />
      ) : (
        <StatusState status="loading" kicker="Reconstruction" title="Opening the reconstruction" />
      )}
    </div>
  );
}
