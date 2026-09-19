import { demo } from "@/demo";
import { buildWireframe } from "@/scene/render/wireframe";
import styles from "./HeroLayer.module.css";

/**
 * The room's shell, shown in the hero frame until the WebGL stage is ready.
 *
 * Built once at module scope from the demo scene, so it is part of the
 * prerendered HTML and paints with the rest of the page rather than waiting
 * on three.js. It says the same thing the first chapter says — here is a
 * room, and we know its shape — instead of holding an empty rectangle.
 */
const room = buildWireframe(demo.scene);

export function RoomWireframe() {
  return (
    <svg
      className={styles.wireframe}
      viewBox={`0 0 ${room.width} ${room.height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <path className={styles.wireShell} d={room.shell} />
      <path className={styles.wireOpening} d={room.openings} />
    </svg>
  );
}
