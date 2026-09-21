"use client";

import type { RefObject } from "react";
import { ScrollTrigger, useGSAP } from "@/lib/gsap";
import type { SceneStage } from "@/scene/render/SceneStage";
import type { ViewState } from "@/scene/render/viewState";
import { chapterAt, chapters, OUTRO_SETTLE, OUTRO_START, timings } from "./chapters";
import { shots } from "./shots";
import { sequenceStore } from "./store";
import { buildTimeline } from "./timeline";

interface Options {
  section: RefObject<HTMLElement | null>;
  root: RefObject<HTMLElement | null>;
  view: ViewState;
  stage: RefObject<SceneStage | null>;
  reducedMotion: boolean;
  portrait: boolean;
}

/**
 * How long the film takes to catch up with the scroll. Enough to turn the
 * steps of a mouse wheel into continuous motion; short enough that the room
 * visibly answers the hand rather than drifting on after it stops.
 */
const SCRUB_SECONDS = 0.35;

/** The settled moment of whichever chapter a timeline time falls in. */
function settledTime(time: number) {
  if (time >= OUTRO_START) return OUTRO_SETTLE;
  const index = chapterAt(time);
  return index < 0 ? 0 : timings[chapters[Math.min(index, chapters.length - 1)].id].settle;
}

/**
 * Binds the film to scroll.
 *
 * Full motion: the timeline is scrubbed, so scroll position is playback
 * position in both directions. Reduced motion: the same content, but each
 * chapter is shown in its settled state and switches without animation.
 */
export function useSequenceTimeline({ section, root, view, stage, reducedMotion, portrait }: Options) {
  useGSAP(
    () => {
      const sectionEl = section.current;
      const rootEl = root.current;
      // Found through the DOM: an ancestor's ref is not attached yet when a
      // child's layout effect runs.
      const themeEl = rootEl?.closest<HTMLElement>("[data-stage-theme]") ?? rootEl;
      if (!sectionEl || !rootEl || !themeEl) return;

      const tl = buildTimeline({ view, root: rootEl, theme: themeEl, shots: shots(portrait) });
      const total = tl.duration();

      tl.eventCallback("onUpdate", () => {
        stage.current?.invalidate();
        const time = tl.time();
        sequenceStore.setChapter(time >= OUTRO_START + 0.5 ? chapters.length : chapterAt(time));
      });

      const trigger = ScrollTrigger.create({
        trigger: sectionEl,
        start: "top top",
        end: "bottom bottom",
        ...(reducedMotion
          ? {
              onUpdate: (self: ScrollTrigger) => {
                const target = settledTime(self.progress * total);
                if (Math.abs(tl.time() - target) > 0.001) tl.time(target);
                sequenceStore.setProgress(self.progress);
              },
            }
          : {
              animation: tl,
              scrub: SCRUB_SECONDS,
              onUpdate: (self: ScrollTrigger) => sequenceStore.setProgress(self.progress),
            }),
      });

      if (reducedMotion) tl.time(settledTime(trigger.progress * total));

      sequenceStore.registerSeek((chapter) => {
        const time = chapter === "end" ? OUTRO_SETTLE : timings[chapters[chapter].id].settle;
        const top = trigger.start + (time / total) * (trigger.end - trigger.start);
        window.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
      });

      return () => sequenceStore.registerSeek(null);
    },
    { dependencies: [reducedMotion, portrait, view], revertOnUpdate: true, scope: root },
  );
}
