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

/** What following a job does to the page. Passed in, so the lifecycle can be tested without React. */
export interface JobEffects {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  setState: (state: JobState) => void;
  setSent: (sent: boolean) => void;
  /** Open a finished run in the workspace. */
  open: (runId: string) => void;
  remember: (runId: string | null) => void;
  recall: () => string | null;
}

/**
 * Sending a photograph and following its job, one generation at a time.
 *
 * Every send, follow, reset or stop ends the generation before it: its timer
 * is cleared and its request aborted. Aborting is not enough on its own, as
 * a response can land in the same moment, so everything that comes back
 * checks that its generation is still the current one before it touches the
 * state, the stored job, the next poll or the page's address. A photograph
 * replaced mid-job therefore can never be overtaken by its old run, and a
 * run is never followed by more than one loop.
 */
export function createJobFollower(effects: JobEffects) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  const end = () => {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  const begin = () => {
    end();
    controller = new AbortController();
    return { id: generation, signal: controller.signal };
  };

  const current = (id: number) => id === generation;

  const poll = async (id: number, signal: AbortSignal, runId: string, startedAt: number) => {
    const later = (ms: number) => {
      if (current(id)) timer = setTimeout(() => void poll(id, signal, runId, startedAt), ms);
    };
    let view: JobView | { code?: string };
    let ok: boolean;
    try {
      const response = await effects.fetch(`${JOBS}/${encodeURIComponent(runId)}`, { cache: "no-store", signal });
      ok = response.ok;
      view = await response.json();
    } catch {
      // The server may be restarting: keep asking, unless this job is no longer the one being followed.
      later(3000);
      return;
    }
    if (!current(id)) return;
    effects.setSent(true);
    if (!ok || !("status" in view)) {
      effects.remember(null);
      effects.setState({ phase: "failed", code: view.code ?? "not-found" });
      return;
    }
    if (view.openable) {
      effects.remember(null);
      effects.setState({ phase: "opening", runId });
      effects.open(runId);
      return;
    }
    if (view.status === "failed") {
      effects.remember(null);
      effects.setState({ phase: "failed", code: view.code ?? "worker-failed" });
      return;
    }
    effects.setState({ phase: view.status === "queued" ? "queued" : "running", runId, position: view.position, elapsedMs: view.elapsedMs });
    later(Date.now() - startedAt > 60_000 ? 3000 : 1500);
  };

  /** Follow a job already sent, as after a reload. */
  const follow = (runId: string) => {
    const { id, signal } = begin();
    void poll(id, signal, runId, Date.now());
  };

  return {
    follow,

    /** Pick up the job remembered from before a reload, if there is one. */
    resume() {
      const pending = effects.recall();
      if (pending) follow(pending);
    },

    async start(blob: Blob, name: string) {
      const { id, signal } = begin();
      effects.setState({ phase: "sending" });
      const body = new FormData();
      body.append("photo", blob, name);
      let response: Response;
      try {
        response = await effects.fetch(JOBS, { method: "POST", body, signal });
      } catch {
        if (current(id)) effects.setState({ phase: "failed", code: "unreachable" });
        return;
      }
      const json = await response.json().catch(() => ({}));
      if (!current(id)) return;
      if (!response.ok) {
        effects.setState({ phase: "failed", code: json.code ?? "upload-failed" });
        return;
      }
      effects.remember(json.runId);
      effects.setSent(true);
      effects.setState({ phase: "queued", runId: json.runId, position: json.position, elapsedMs: null });
      void poll(id, signal, json.runId, Date.now());
    },

    /** Let go of the job entirely: the photograph was replaced or removed. */
    reset() {
      end();
      effects.remember(null);
      effects.setSent(false);
      effects.setState({ phase: "idle" });
    },

    /** Stop following without forgetting the job, so a reload can pick it up again. */
    stop: end,
  };
}

export type JobFollower = ReturnType<typeof createJobFollower>;

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
  const alive = useRef(true);
  // One follower for the life of this page. `router` is Next's single app router, the same on every render.
  const [follower] = useState(() =>
    createJobFollower({
      fetch: (input, init) => fetch(input, init),
      setState,
      setSent,
      open: (runId) => router.replace(`${routes.workspace}/reconstruction/${encodeURIComponent(runId)}`),
      remember,
      recall: recalled,
    }),
  );

  useEffect(() => {
    alive.current = true;
    fetch("/api/reconstructions/local", { cache: "no-store" })
      .then(async (r) => alive.current && setConnected(r.ok || (await r.json().catch(() => null))?.code !== "not-configured"))
      .catch(() => alive.current && setConnected(false));
    // Picked up after a reload: the first answer from the server sets the state.
    // Strict Mode's second mount ends the first mount's generation, so one loop remains.
    follower.resume();
    return () => {
      alive.current = false;
      follower.stop();
    };
  }, [follower]);

  const start = useCallback((blob: Blob, name: string) => follower.start(blob, name), [follower]);
  const reset = useCallback(() => follower.reset(), [follower]);

  return { state, connected, sent, start, reset };
}
