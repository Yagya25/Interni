"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { routes } from "@/config/site";
import type { JobView } from "../reconstruction/jobs/types";

const JOBS = "/api/reconstructions/local/jobs";
/** The job in flight, so a reload picks the polling back up. A convenience: without storage the job still finishes. */
const KEY = "datum.reconstruction.job";

export type JobState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "queued" | "running"; runId: string; position: number | null; elapsedMs: number | null }
  | { phase: "opening"; runId: string }
  | { phase: "failed"; code: string };

const remember = (runId: string | null) => {
  try {
    if (runId) localStorage.setItem(KEY, runId);
    else localStorage.removeItem(KEY);
  } catch {
    // Not kept: this visit still follows the job to the end.
  }
};

const recalled = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/**
 * Sending the photograph to the reconstruction worker on this machine, and
 * following the job until the room can be opened. The server starts the
 * worker; this only asks for it and watches.
 */
export function useReconstructionJob() {
  const router = useRouter();
  const [state, setState] = useState<JobState>({ phase: "idle" });
  /** Whether this machine has a runs folder at all: null until known. */
  const [connected, setConnected] = useState<boolean | null>(null);
  /** Whether this photograph has been handed to the worker, for the caption under it. */
  const [sent, setSent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const follow = useCallback(
    (runId: string, startedAt = Date.now()) => {
      stop();
      const poll = async () => {
        let view: JobView | { code?: string };
        let ok: boolean;
        try {
          const response = await fetch(`${JOBS}/${encodeURIComponent(runId)}`, { cache: "no-store" });
          ok = response.ok;
          view = await response.json();
        } catch {
          // The server may be restarting: keep asking.
          if (alive.current) timer.current = setTimeout(poll, 3000);
          return;
        }
        if (!alive.current) return;
        setSent(true);
        if (!ok || !("status" in view)) {
          remember(null);
          setState({ phase: "failed", code: view.code ?? "not-found" });
          return;
        }
        if (view.openable) {
          remember(null);
          setState({ phase: "opening", runId });
          router.replace(`${routes.workspace}/reconstruction/${encodeURIComponent(runId)}`);
          return;
        }
        if (view.status === "failed") {
          remember(null);
          setState({ phase: "failed", code: view.code ?? "worker-failed" });
          return;
        }
        setState({ phase: view.status === "queued" ? "queued" : "running", runId, position: view.position, elapsedMs: view.elapsedMs });
        timer.current = setTimeout(poll, Date.now() - startedAt > 60_000 ? 3000 : 1500);
      };
      void poll();
    },
    [router],
  );

  useEffect(() => {
    alive.current = true;
    fetch("/api/reconstructions/local", { cache: "no-store" })
      .then(async (r) => alive.current && setConnected(r.ok || (await r.json().catch(() => null))?.code !== "not-configured"))
      .catch(() => alive.current && setConnected(false));
    const pending = recalled();
    // Picked up after a reload: the first answer from the server sets the state.
    if (pending) follow(pending);
    return () => {
      alive.current = false;
      stop();
    };
  }, [follow]);

  const start = useCallback(
    async (blob: Blob, name: string) => {
      setState({ phase: "sending" });
      const body = new FormData();
      body.append("photo", blob, name);
      let response: Response;
      try {
        response = await fetch(JOBS, { method: "POST", body });
      } catch {
        if (alive.current) setState({ phase: "failed", code: "unreachable" });
        return;
      }
      const json = await response.json().catch(() => ({}));
      if (!alive.current) return;
      if (!response.ok) {
        setState({ phase: "failed", code: json.code ?? "upload-failed" });
        return;
      }
      remember(json.runId);
      setSent(true);
      setState({ phase: "queued", runId: json.runId, position: json.position, elapsedMs: null });
      follow(json.runId);
    },
    [follow],
  );

  const reset = useCallback(() => {
    stop();
    remember(null);
    setSent(false);
    setState({ phase: "idle" });
  }, []);

  return { state, connected, sent, start, reset };
}
