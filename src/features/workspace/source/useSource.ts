"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { analyse, check } from "./analyse";
import { clear, load, save } from "./storage";
import { phaseOf, type SourceState } from "./types";

/**
 * The person's own room, taken in and held.
 *
 * The image is shown the moment it is chosen and stays on screen through
 * every state after that. It is never swapped for the demonstration room,
 * and reaching the demonstration room is always a separate, deliberate act.
 *
 * The blob is kept beside the state rather than inside it: the interface
 * needs the picture whatever phase it is in, and the phase changes more
 * often than the picture does.
 */
export function useSource() {
  const [state, setState] = useState<SourceState>({ status: "empty" });
  const [blob, setBlob] = useState<Blob | null>(null);
  /** Rises with each new file, so a slow analysis cannot land on a newer one. */
  const run = useRef(0);

  // Pick up a photograph held from a previous visit. ------------------------
  useEffect(() => {
    let cancelled = false;
    void load().then((stored) => {
      if (cancelled || !stored) return;
      setBlob(stored.blob);
      setState(
        stored.analysis
          ? { status: "ready", photograph: stored.photograph, analysis: stored.analysis }
          : { status: "uploaded", photograph: stored.photograph },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const take = useCallback(async (file: File) => {
    const ticket = (run.current += 1);
    const problem = check(file);
    if (problem) {
      setBlob(null);
      setState({ status: "error", problem, name: file.name });
      return;
    }

    // The picture goes up straight away; the reading of it follows.
    setBlob(file);
    setState({ status: "uploading", name: file.name, step: 1 });

    const outcome = await analyse(file, (step) => {
      if (run.current === ticket) {
        setState({ status: phaseOf(step), name: file.name, step });
      }
    });
    if (run.current !== ticket) return;

    if (!outcome.ok) {
      setBlob(null);
      setState({ status: "error", problem: outcome.problem, name: file.name });
      return;
    }

    const photograph = {
      id: `${Date.now().toString(36)}-${Math.round(file.size).toString(36)}`,
      name: file.name,
      type: file.type,
      bytes: file.size,
      width: outcome.decoded.width,
      height: outcome.decoded.height,
      addedAt: new Date().toISOString(),
    };
    const analysis = outcome.decoded.analysis;
    setState({ status: "ready", photograph, analysis });

    // Keeping it is a convenience, not a requirement: a browser that
    // refuses storage still gets the whole experience for this visit.
    const kept = await save({ photograph, analysis, blob: file });
    if (!kept && run.current === ticket) console.info("[source] the photograph was not kept");
  }, []);

  const discard = useCallback(() => {
    run.current += 1;
    setBlob(null);
    setState({ status: "empty" });
    void clear();
  }, []);

  return { state, blob, take, discard };
}
