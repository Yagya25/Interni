import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import styles from "./Text.module.css";

/**
 * Typographic roles, not sizes. Each role pairs a family, size, leading and
 * tracking so the same role always reads the same way.
 *
 * display-*  Newsreader, editorial headlines
 * body-*     Hanken Grotesk, running text
 * label      IBM Plex Mono, uppercase technical labels
 * meta       IBM Plex Mono, sentence-case measurements and captions
 */
export type TextVariant =
  | "display-xl"
  | "display-l"
  | "display-m"
  | "body-l"
  | "body"
  | "small"
  | "label"
  | "meta";

type TextProps<E extends ElementType> = {
  as?: E;
  variant: TextVariant;
  tone?: "default" | "muted" | "subtle";
  className?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<E>, "as" | "className" | "children">;

export function Text<E extends ElementType = "p">({
  as,
  variant,
  tone = "default",
  className,
  children,
  ...rest
}: TextProps<E>) {
  const Component: ElementType = as ?? "p";
  const classes = [styles[variant], tone !== "default" && styles[tone], className]
    .filter(Boolean)
    .join(" ");
  return (
    <Component className={classes} {...rest}>
      {children}
    </Component>
  );
}
