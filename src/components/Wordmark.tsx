import { site } from "@/config/site";
import styles from "./Wordmark.module.css";

/**
 * The mark is a photograph frame that contains a room in one-point
 * perspective: an image that already holds a space.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2.75" y="2.75" width="18.5" height="18.5" />
        <rect x="8.75" y="7.75" width="6.5" height="7.5" />
        <path d="M2.75 2.75l6 5M21.25 2.75l-6 5M2.75 21.25l6-6M21.25 21.25l-6-6" />
      </g>
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={[styles.wordmark, className].filter(Boolean).join(" ")}>
      <Mark className={styles.mark} />
      <span className={styles.name}>{site.name}</span>
    </span>
  );
}
