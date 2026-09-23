"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusState } from "@/components/StatusState";
import { Text } from "@/components/Text";
import { routes } from "@/config/site";
import type { RunSummary } from "./localRuns";
import { problemCopy } from "./loadRun";
import styles from "./Reconstruction.module.css";

type State = { status: "loading" } | { status: "error"; code: string } | { status: "ready"; runs: RunSummary[] };

const COMMAND = `wsl -d Ubuntu
cd ~/datum-recon && source .venv/bin/activate
python -m reconstruction.worker --input /path/to/room.jpg`;

/** Reconstructions the worker has written on this machine, newest first. */
export function ReconstructionIndex() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/reconstructions/local", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (cancelled) return;
        setState(response.ok ? { status: "ready", runs: body.runs } : { status: "error", code: body.code ?? "not-found" });
      })
      .catch(() => !cancelled && setState({ status: "error", code: "unreachable" }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <Text as="p" variant="label" tone="muted">
        Local reconstructions
      </Text>
      <Text as="h1" variant="display-m">
        Rooms rebuilt from photographs on this machine.
      </Text>
      <Text as="p" variant="body" tone="muted">
        Each is compiled in this browser from what the reconstruction worker observed: camera, depth and the room’s
        planes. Furniture, materials and light come in later milestones. Run the worker on a photograph:
      </Text>
      <pre className={styles.command}>{COMMAND}</pre>

      {state.status === "loading" && <StatusState status="loading" title="Reading the runs folder" compact />}
      {state.status === "error" && (
        <StatusState status="error" title={problemCopy(state.code).title} description={<p>{problemCopy(state.code).detail}</p>} compact />
      )}
      {state.status === "ready" &&
        (state.runs.length ? (
          <ul className={styles.list}>
            {state.runs.map((run) => (
              <li key={run.runId} className={styles.item}>
                <Link href={`${routes.workspace}/reconstruction/${run.runId}`}>{run.runId}</Link>
                <span className={styles.meta}>
                  {run.status ?? "unknown"}
                  {run.image && ` · ${run.image.width} × ${run.image.height}`}
                  {run.planes.wall !== undefined && ` · ${run.planes.wall} walls`}
                  {run.planes.ceiling ? " · ceiling" : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <StatusState status="empty" title="No reconstructions yet." compact />
        ))}
    </section>
  );
}
