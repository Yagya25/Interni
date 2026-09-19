import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import styles from "./Button.module.css";

type Variant = "solid" | "line" | "text";
type Size = "m" | "l";

interface CommonProps {
  variant?: Variant;
  size?: Size;
  /** Trailing arrow. Signals navigation forward, not decoration. */
  arrow?: boolean;
  children: ReactNode;
  className?: string;
}

function classNames(variant: Variant, size: Size, className?: string) {
  return [styles.button, styles[variant], styles[size], className].filter(Boolean).join(" ");
}

function Content({ children, arrow }: { children: ReactNode; arrow?: boolean }) {
  return (
    <>
      <span className={styles.label}>{children}</span>
      {arrow && (
        <svg className={styles.arrow} viewBox="0 0 16 10" aria-hidden="true" focusable="false">
          <path d="M0 5h14.5M10.5 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.25" />
        </svg>
      )}
    </>
  );
}

export function ButtonLink({
  variant = "solid",
  size = "m",
  arrow,
  children,
  className,
  ...rest
}: CommonProps & Omit<ComponentPropsWithoutRef<typeof Link>, "className" | "children">) {
  return (
    <Link className={classNames(variant, size, className)} {...rest}>
      <Content arrow={arrow}>{children}</Content>
    </Link>
  );
}

export function Button({
  variant = "solid",
  size = "m",
  arrow,
  children,
  className,
  type = "button",
  ...rest
}: CommonProps & Omit<ComponentPropsWithoutRef<"button">, "className" | "children">) {
  return (
    <button type={type} className={classNames(variant, size, className)} {...rest}>
      <Content arrow={arrow}>{children}</Content>
    </button>
  );
}
