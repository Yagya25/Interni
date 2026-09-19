import { demo } from "@/demo";
import type { ViewState } from "@/scene/render/viewState";

export type Shot = ViewState["camera"];

const capture = demo.scene.camera;

/** The photograph's own viewpoint: where the story starts and ends. */
export const captureShot: Shot = {
  px: capture.position[0],
  py: capture.position[1],
  pz: capture.position[2],
  tx: capture.target[0],
  ty: capture.target[1],
  tz: capture.target[2],
  fov: capture.verticalFov,
};

const shot = (p: [number, number, number], t: [number, number, number], fov: number): Shot => ({
  px: p[0],
  py: p[1],
  pz: p[2],
  tx: t[0],
  ty: t[1],
  tz: t[2],
  fov,
});

/**
 * Camera positions for each chapter, in room coordinates (metres).
 * Mobile shots stand further back so a portrait frame still holds the room.
 */
export function shots(portrait: boolean) {
  return {
    capture: captureShot,
    /** A slow dolly across the room: parallax makes depth legible. */
    depth: portrait ? shot([1.6, 1.4, 2.25], [-1.1, 0.95, -1.4], 52) : shot([1.55, 1.42, 1.75], [-1.35, 0.95, -1.45], 50),
    /** In front of the room, raised: the exploded structure reads as a drawing. */
    // Portrait: steeper, so the plan's depth uses the tall frame.
    structure: portrait ? shot([1.4, 11.2, 11.4], [0, 0.9, -0.5], 40) : shot([2.4, 5.1, 9.8], [0.35, 1.0, -0.4], 36),
    /** Looking down onto the furniture. */
    objects: portrait ? shot([1.8, 4.6, 5.8], [-0.8, 0.25, -0.8], 50) : shot([2.0, 3.6, 4.3], [-0.85, 0.3, -0.85], 44),
    materials: portrait ? shot([2.1, 1.7, 2.9], [-1.0, 0.8, -1.2], 52) : shot([2.05, 1.6, 2.55], [-1.05, 0.78, -1.25], 50),
    /** Inside, raised: every edit is in frame. */
    edit: portrait ? shot([1.9, 2.6, 2.3], [-0.9, 0.3, -0.7], 56) : shot([1.95, 2.2, 2.25], [-0.9, 0.35, -0.7], 56),
    /** The cutaway: the whole room as an object. */
    space: portrait ? shot([3.2, 10.8, 14.2], [-0.2, 0.3, -0.2], 34) : shot([3.0, 7.8, 10.4], [-0.3, 0.25, -0.3], 30),
    /** Higher, towards plan: relationships read on the floor. */
    understanding: portrait ? shot([0.9, 15.5, 10.8], [-0.1, 0, -0.3], 34) : shot([2.0, 12.8, 9.7], [0.45, 0, -0.75], 30),
    /** A touch closer than the capture for the closing frame. */
    closing: portrait
      ? shot([1.95, 1.3, 1.95], [-1.2, 0.98, -1.25], 52)
      : shot([2.0, 1.3, 1.95], [-1.25, 0.98, -1.28], 50),
  } satisfies Record<string, Shot>;
}

export type Shots = ReturnType<typeof shots>;
