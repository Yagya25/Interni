import { gsap } from "@/lib/gsap";
import type { ViewState } from "@/scene/render/viewState";
import { chapters, INTRO_SPAN, OUTRO_START, timings, TOTAL_SPAN, type ChapterId } from "./chapters";
import type { Shot, Shots } from "./shots";

/**
 * The film.
 *
 * One timeline, measured in abstract units, drives two things:
 *  - `view`, the plain object the 3D stage renders from;
 *  - the DOM overlays (copy, labels, panels) inside `root`.
 *
 * Scroll maps linearly onto this timeline. Every tween is positioned
 * absolutely, so chapter timings can change without touching the rest.
 */

interface TimelineInput {
  view: ViewState;
  root: HTMLElement;
  /** Element whose CSS custom properties retune text for dark scenes. */
  theme: HTMLElement;
  shots: Shots;
}

const DARK_INK = { "--stage-ink": "#191816", "--stage-ink-2": "#46433d", "--stage-rule": "rgba(25,24,22,0.34)", "--stage-scrim": "rgba(239,236,230,0.82)" };
const LIGHT_INK = { "--stage-ink": "#f4f1eb", "--stage-ink-2": "#d9d3c9", "--stage-rule": "rgba(244,241,235,0.4)", "--stage-scrim": "rgba(22,21,19,0.55)" };

export function buildTimeline({ view, root, theme, shots }: TimelineInput) {
  const q = gsap.utils.selector(root);
  const tl = gsap.timeline({ defaults: { ease: "none" }, paused: true });
  const T = (id: ChapterId) => timings[id];

  // Helpers --------------------------------------------------------------------
  const camera = (shot: Shot, at: number, duration: number, ease = "power2.inOut") =>
    tl.to(view.camera, { ...shot, duration, ease }, at);
  const to = (target: object, vars: gsap.TweenVars, at: number, duration: number, ease = "power1.inOut") =>
    tl.to(target, { ...vars, duration, ease }, at);
  // Text-only layers (`data-keep`) fade with opacity alone so assistive
  // technology can still read them; anything interactive uses autoAlpha so
  // it leaves the tab order while hidden.
  const fade = (el: Element | undefined) => (el?.closest("[data-keep]") ? "opacity" : "autoAlpha");
  const layer = (name: string, at: number, duration: number, show: boolean) => {
    const els = q(`[data-layer="${name}"]`);
    return tl.to(els, { [fade(els[0])]: show ? 1 : 0, duration, ease: "power1.inOut" }, at);
  };
  const stagger = (selector: string, at: number, each: number, show: boolean, duration = 0.8) => {
    const els = q(selector);
    return tl.to(
      els,
      { [fade(els[0])]: show ? 1 : 0, y: show ? 0 : -6, duration, stagger: each, ease: "power2.out" },
      at,
    );
  };

  const copyIn = (id: ChapterId, at: number) => {
    tl.fromTo(
      q(`[data-chapter="${id}"]`),
      { opacity: 0, y: 0 },
      { opacity: 1, duration: 0.6, immediateRender: false },
      at,
    );
    tl.fromTo(
      q(`[data-chapter="${id}"] [data-mask]`),
      { yPercent: 105 },
      { yPercent: 0, duration: 1.6, ease: "power3.out", immediateRender: false },
      at,
    );
    tl.fromTo(
      q(`[data-chapter="${id}"] [data-rise]`),
      { opacity: 0, y: 14 },
      { opacity: 1, y: 0, duration: 1.4, ease: "power2.out", stagger: 0.25, immediateRender: false },
      at + 0.4,
    );
  };
  const copyOut = (id: ChapterId, at: number) =>
    tl.to(q(`[data-chapter="${id}"]`), { opacity: 0, y: -18, duration: 1.1, ease: "power1.in" }, at);

  // Initial state ------------------------------------------------------------
  gsap.set(q("[data-chapter]"), { opacity: 0 });
  q("[data-layer]").forEach((el) => gsap.set(el, { [fade(el)]: 0 }));
  q("[data-layer] [data-item]").forEach((el) => gsap.set(el, { [fade(el)]: 0 }));
  gsap.set(q("[data-tool]"), { "--tool-active": 0 });
  gsap.set(q("[data-time-scale]"), { "--time": 0 });
  gsap.set(theme, DARK_INK);

  // Intro: the print becomes the room -----------------------------------------
  to(view, { frame: 0 }, 0, INTRO_SPAN * 0.85, "power2.inOut");
  // Explicit start values: the cover's own entrance animation may still be
  // running when this is built, and its values must not be captured.
  tl.fromTo(
    q("[data-hero-copy]"),
    { autoAlpha: 1, y: 0 },
    { autoAlpha: 0, y: -60, duration: INTRO_SPAN * 0.45, ease: "power1.in", immediateRender: false },
    0,
  );
  tl.to(q("[data-hero-caption]"), { autoAlpha: 0, duration: 1.2 }, 0);
  camera(
    { ...shots.capture, px: shots.capture.px - 0.12, pz: shots.capture.pz - 0.16 },
    0,
    INTRO_SPAN + 6,
    "power1.inOut",
  );
  layer("demo-note", INTRO_SPAN * 0.7, 1.2, true);
  tl.fromTo(q("[data-scrim]"), { opacity: 0 }, { opacity: 1, duration: 2, immediateRender: false }, INTRO_SPAN * 0.55);

  // 01 Photograph ----------------------------------------------------------------
  const photo = T("photo");
  copyIn("photo", photo.start - 2.2);
  copyOut("photo", photo.end - 1.4);

  // 02 Depth -------------------------------------------------------------------------
  const depth = T("depth");
  copyIn("depth", depth.start + 0.6);
  to(view, { depth: 1 }, depth.start, 1.8);
  const depthSpan = depth.end - depth.start;
  to(view, { depthFront: 10 }, depth.start, depthSpan * 0.7, "power1.in");
  camera(shots.depth, depth.start, depthSpan, "sine.inOut");
  to(q("[data-grain]"), { opacity: 0.25 }, depth.start, 4);
  layer("depth-legend", depth.start + 2, 1.2, true);
  layer("depth-legend", depth.end - 1.6, 1, false);
  copyOut("depth", depth.end - 1.4);

  // 03 Structure ------------------------------------------------------------------
  const structure = T("structure");
  copyIn("structure", structure.start + 1);
  to(view, { depth: 0, clay: 1 }, structure.start, 2.6);
  to(q("[data-grain]"), { opacity: 0 }, structure.start, 2.4);
  to(view, { edges: 1, dimObjects: 0.74 }, structure.start + 1, 2.4);
  camera(shots.structure, structure.start, 7.5);
  to(view, { explode: 1 }, structure.start + 3, 6, "power2.inOut");
  layer("structure", structure.start + 7.2, 0.8, true);
  stagger('[data-layer="structure"] [data-item]', structure.start + 7.2, 0.18, true);
  layer("structure", structure.end - 2.2, 1, false);
  copyOut("structure", structure.end - 1.4);

  // 04 Objects ---------------------------------------------------------------------
  const objects = T("objects");
  to(view, { explode: 0 }, objects.start - 2, 3.4, "power2.inOut");
  to(view, { dimObjects: 0, dimArchitecture: 0.55, edges: 0.25 }, objects.start - 0.5, 2.5);
  camera(shots.objects, objects.start - 1.5, 6.5);
  copyIn("objects", objects.start + 1);
  to(view, { separate: 1 }, objects.start + 2, 4, "power2.inOut");
  to(view, { boxes: 1 }, objects.start + 2.4, 2.4);
  layer("objects", objects.start + 3, 0.6, true);
  stagger('[data-layer="objects"] [data-item]', objects.start + 3, 0.12, true);
  layer("object-counts", objects.start + 4, 1.2, true);
  to(view, { separate: 0, boxes: 0 }, objects.end - 3, 3, "power2.inOut");
  layer("objects", objects.end - 3, 1.2, false);
  layer("object-counts", objects.end - 2.6, 1.2, false);
  copyOut("objects", objects.end - 1.4);

  // 05 Materials -------------------------------------------------------------------
  const materials = T("materials");
  to(view, { dimArchitecture: 0, edges: 0 }, materials.start - 1, 2.2);
  camera(shots.materials, materials.start - 1, 7);
  copyIn("materials", materials.start + 1);
  const order = ["wood", "fabric", "stone", "glass", "metal", "leather", "paint", "other"] as const;
  order.forEach((group, i) => {
    tl.to(view.reveal, { [group]: 1, duration: 2.8, ease: "power1.in" }, materials.start + 1.8 + i * 0.75);
  });
  layer("materials", materials.start + 1.8, 0.4, true);
  stagger('[data-layer="materials"] [data-item]', materials.start + 1.9, 0.75, true, 1);
  layer("materials", materials.end - 2, 1.2, false);
  to(view, { clay: 0 }, materials.end - 0.5, 0.5);
  copyOut("materials", materials.end - 1.4);

  // 06 Light -------------------------------------------------------------------------
  const light = T("light");
  camera(shots.capture, light.start - 1, 6);
  copyIn("light", light.start + 1);
  to(view, { rays: 1 }, light.start + 1.5, 2);
  layer("light", light.start + 1.8, 1, true);
  stagger('[data-layer="light"] [data-item]', light.start + 1.8, 0.3, true);
  layer("time-scale", light.start + 2, 1, true);
  to(view, { time: 0.5 }, light.start + 3, 4.6, "sine.inOut");
  to(view, { time: 1 }, light.start + 8, 4.4, "sine.inOut");
  to(view, { rays: 0 }, light.start + 9.5, 2);
  to(theme, LIGHT_INK, light.start + 9.8, 2.2);
  // The scale's marker follows the same clock as the sun.
  tl.to(q("[data-time-scale]"), { "--time": 0.5, duration: 4.6, ease: "sine.inOut" }, light.start + 3);
  tl.to(q("[data-time-scale]"), { "--time": 1, duration: 4.4, ease: "sine.inOut" }, light.start + 8);
  layer("light", light.end - 1.8, 1, false);
  layer("time-scale", light.end - 1.6, 1, false);
  copyOut("light", light.end - 1.4);

  // 07 Edit -------------------------------------------------------------------------
  const edit = T("edit");
  camera(shots.edit, edit.start - 1, 5);
  copyIn("edit", edit.start + 1);
  layer("edit-tools", edit.start + 2, 1, true);
  const steps: { tool: string; at: number; run: () => void }[] = [
    { tool: "move", at: edit.start + 3, run: () => to(view, { editMove: 1 }, edit.start + 3.3, 2.6, "power2.inOut") },
    { tool: "replace", at: edit.start + 6.2, run: () => to(view, { editReplace: 1 }, edit.start + 6.5, 2.8, "power1.inOut") },
    { tool: "material", at: edit.start + 9.6, run: () => to(view, { editMaterial: 1 }, edit.start + 9.9, 2.4) },
    {
      tool: "light",
      at: edit.start + 12.6,
      run: () => {
        to(view, { time: 0.55 }, edit.start + 12.9, 2.6, "sine.inOut");
        to(theme, DARK_INK, edit.start + 12.9, 1.8);
      },
    },
  ];
  steps.forEach(({ tool, at, run }, i) => {
    tl.to(q(`[data-tool="${tool}"]`), { "--tool-active": 1, duration: 0.5 }, at);
    if (i > 0) tl.to(q(`[data-tool="${steps[i - 1].tool}"]`), { "--tool-active": 0, duration: 0.5 }, at);
    layer(`edit-${tool}`, at, 0.6, true);
    layer(`edit-${tool}`, at + 3.1, 0.6, false);
    run();
  });
  tl.to(q(`[data-tool="light"]`), { "--tool-active": 0, duration: 0.5 }, edit.end - 0.8);
  layer("edit-tools", edit.end - 1.4, 1, false);
  copyOut("edit", edit.end - 1.4);

  // 08 Space ------------------------------------------------------------------------
  const space = T("space");
  camera(shots.space, space.start - 0.5, 8.5, "power2.inOut");
  to(view, { cutaway: 1 }, space.start + 0.5, 4);
  to(view, { edges: 0.4 }, space.start + 4, 3);
  copyIn("space", space.start + 2.5);
  copyOut("space", space.end - 1.4);

  // 09 Understanding -----------------------------------------------------------
  const understanding = T("understanding");
  camera(shots.understanding, understanding.start - 1, 7.5);
  copyIn("understanding", understanding.start + 1);
  layer("inspection", understanding.start + 1.2, 1, true);
  stagger('[data-layer="inspection"] [data-item]', understanding.start + 1.4, 0.28, true);
  to(view, { dimensions: 1 }, understanding.start + 2.2, 2);
  layer("dimensions", understanding.start + 3, 1, true);
  to(view, { relations: 1, boxes: 0.45 }, understanding.start + 3.6, 3);
  layer("relations", understanding.start + 4.6, 1.2, true);
  layer("inspection", understanding.end - 2, 1.2, false);
  layer("relations", understanding.end - 2.4, 1, false);
  layer("dimensions", understanding.end - 2.4, 1, false);
  to(view, { relations: 0, dimensions: 0, boxes: 0 }, understanding.end - 2.4, 2);
  copyOut("understanding", understanding.end - 1.4);

  // 10 Reimagine ------------------------------------------------------------------
  const reimagine = T("reimagine");
  camera(shots.capture, reimagine.start - 0.5, 14, "power2.inOut");
  to(view, { edges: 0 }, reimagine.start, 2);
  copyIn("reimagine", reimagine.start + 1);
  to(view, { arrange: 1 }, reimagine.start + 1, 6, "power2.inOut");
  to(view, { waveLine: 1 }, reimagine.start + 4, 0.8);
  to(view, { wave: 1 }, reimagine.start + 4.5, 9.5, "sine.inOut");
  to(view, { waveLine: 0 }, reimagine.start + 13.6, 1);
  to(view, { time: 0.64 }, reimagine.start + 4.5, 10, "sine.inOut");
  to(view, { cutaway: 0 }, reimagine.start + 8, 5.5);
  layer("variant", reimagine.start + 7, 1.2, true);
  stagger('[data-layer="variant"] [data-item]', reimagine.start + 7.2, 0.25, true);
  layer("variant", reimagine.end - 2.4, 1.2, false);
  copyOut("reimagine", reimagine.end - 1.8);

  // Closing -----------------------------------------------------------------------
  camera(shots.closing, OUTRO_START - 2, TOTAL_SPAN - OUTRO_START + 2, "power1.inOut");
  // The redesigned room becomes a photograph again: grain returns, lightly.
  to(q("[data-grain]"), { opacity: 0.32 }, OUTRO_START - 1, 4);
  layer("demo-note", OUTRO_START, 1, false);
  to(q("[data-scrim]"), { opacity: 0 }, OUTRO_START - 1, 1.5);
  layer("closing", OUTRO_START + 0.5, 0.5, true);
  tl.fromTo(
    q('[data-layer="closing"] [data-mask]'),
    { yPercent: 105 },
    { yPercent: 0, duration: 2, ease: "power3.out", stagger: 0.9, immediateRender: false },
    OUTRO_START + 0.8,
  );
  tl.fromTo(
    q('[data-layer="closing"] [data-rise]'),
    { autoAlpha: 0, y: 16 },
    { autoAlpha: 1, y: 0, duration: 1.6, ease: "power2.out", stagger: 0.5, immediateRender: false },
    OUTRO_START + 4.5,
  );

  // Pad to the full length so the last frame holds.
  tl.set({}, {}, TOTAL_SPAN);
  chapters.forEach((c) => tl.addLabel(c.id, timings[c.id].settle));
  return tl;
}
