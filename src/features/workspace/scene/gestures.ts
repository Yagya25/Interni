/**
 * Pointer gestures over the viewport, for mouse, trackpad and touch alike.
 *
 * The recogniser knows nothing about the room; it reports what the hand did
 * and lets the viewport decide what that means. Two rules shape it:
 *
 * - A press is a selection until it has travelled far enough to be a drag,
 *   so nudging the mouse while clicking never shoves the furniture.
 * - Anything the viewport does not claim moves the camera instead, which is
 *   why an empty patch of floor orbits and a sofa does not.
 */

export interface GestureHandlers {
  /** Claim this press. Returning true routes the drag to `onDragMove`. */
  onPress(x: number, y: number): boolean;
  /** `shiftKey` is passed through for constraints such as angle snapping. */
  onDragMove(x: number, y: number, shiftKey: boolean): void;
  onDragEnd(): void;
  /** A press that never travelled: select what is under it, or deselect. */
  onTap(x: number, y: number): void;
  onOrbit(dx: number, dy: number): void;
  onPan(dx: number, dy: number): void;
  /** Positive pulls the view back. */
  onDolly(notches: number): void;
  onHover(x: number, y: number): void;
  onHoverEnd(): void;
}

/** How far a press travels before it stops being a click, in pixels. */
const SLOP = 4;

type Mode = "pending" | "drag" | "orbit" | "pan" | "pinch";

export function attachGestures(element: HTMLElement, handlers: GestureHandlers): () => void {
  const points = new Map<number, { x: number; y: number }>();
  let mode: Mode = "pending";
  let active = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let pinchDistance = 0;
  let claimed = false;

  const centre = () => {
    let x = 0;
    let y = 0;
    for (const p of points.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / points.size, y: y / points.size };
  };

  const spread = () => {
    const [a, b] = [...points.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointerDown = (event: PointerEvent) => {
    element.setPointerCapture(event.pointerId);
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (points.size === 2) {
      // A second finger turns a drag into a pinch; whatever the first was
      // doing is abandoned rather than finished.
      if (mode === "drag") handlers.onDragEnd();
      mode = "pinch";
      pinchDistance = spread();
      const c = centre();
      lastX = c.x;
      lastY = c.y;
      return;
    }
    if (points.size > 2) return;

    active = true;
    claimed = false;
    startX = lastX = event.clientX;
    startY = lastY = event.clientY;
    // A middle or right button always slides the room. Shift does too, but
    // only once the viewport has declined the press — Shift also means
    // "snap" to a gesture that was claimed, and a claim comes first.
    mode = event.button === 1 || event.button === 2 ? "pan" : "pending";
    handlers.onHoverEnd();
  };

  const onPointerMove = (event: PointerEvent) => {
    const tracked = points.get(event.pointerId);
    if (!tracked) {
      if (points.size === 0) handlers.onHover(event.clientX, event.clientY);
      return;
    }
    tracked.x = event.clientX;
    tracked.y = event.clientY;

    if (mode === "pinch") {
      const distance = spread();
      if (pinchDistance > 0 && distance > 0) handlers.onDolly((pinchDistance - distance) * 0.9);
      pinchDistance = distance;
      const c = centre();
      handlers.onPan(c.x - lastX, c.y - lastY);
      lastX = c.x;
      lastY = c.y;
      return;
    }

    if (mode === "pending") {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < SLOP) return;
      // Far enough to be a gesture: ask whether the viewport wants it.
      claimed = handlers.onPress(startX, startY);
      mode = claimed ? "drag" : event.shiftKey ? "pan" : "orbit";
    }

    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    if (mode === "drag") handlers.onDragMove(event.clientX, event.clientY, event.shiftKey);
    else if (mode === "pan") handlers.onPan(dx, dy);
    else handlers.onOrbit(dx, dy);
  };

  const release = (event: PointerEvent) => {
    points.delete(event.pointerId);
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);

    if (mode === "pinch") {
      // Back to one finger: continue as an orbit from where it now is.
      const remaining = [...points.values()][0];
      if (remaining) {
        mode = "orbit";
        lastX = remaining.x;
        lastY = remaining.y;
        return;
      }
    }
    if (points.size > 0) return;

    if (mode === "drag" && claimed) handlers.onDragEnd();
    else if (active && mode === "pending") handlers.onTap(startX, startY);
    active = false;
    mode = "pending";
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    // Trackpad pinches arrive as ctrl+wheel; both mean the same thing here.
    handlers.onDolly(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY);
  };

  const onPointerLeave = () => {
    if (points.size === 0) handlers.onHoverEnd();
  };

  const onContextMenu = (event: Event) => event.preventDefault();

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
  element.addEventListener("pointerleave", onPointerLeave);
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("contextmenu", onContextMenu);

  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", release);
    element.removeEventListener("pointercancel", release);
    element.removeEventListener("pointerleave", onPointerLeave);
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("contextmenu", onContextMenu);
  };
}
