import type { ReactNode } from "react";
import styles from "./StatusState.module.css";

export type Status = "loading" | "error" | "empty" | "success";

interface StatusStateProps {
  status: Status;
  /** Overrides the default label for the status, e.g. "Not found". */
  kicker?: string;
  title: string;
  description?: ReactNode;
  /** Optional action, e.g. a retry button or a link back. */
  action?: ReactNode;
  /** Compact variant for overlays inside other surfaces. */
  compact?: boolean;
  className?: string;
}

const statusLabel: Record<Status, string> = {
  loading: "Working",
  error: "Error",
  empty: "Nothing here yet",
  success: "Done",
};

/**
 * One component for the four states every asynchronous surface needs.
 * Errors are announced assertively; everything else politely.
 */
export function StatusState({
  status,
  kicker,
  title,
  description,
  action,
  compact,
  className,
}: StatusStateProps) {
  return (
    <div
      className={[styles.root, compact && styles.compact, className].filter(Boolean).join(" ")}
      data-status={status}
      role={status === "error" ? "alert" : "status"}
      aria-live={status === "error" ? "assertive" : "polite"}
      aria-busy={status === "loading" || undefined}
    >
      <div className={styles.head}>
        <span className={styles.indicator} aria-hidden="true" />
        <span className={styles.kicker}>{kicker ?? statusLabel[status]}</span>
      </div>
      <p className={styles.title}>{title}</p>
      {description && <div className={styles.description}>{description}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
