import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import styles from "./Container.module.css";

type ContainerProps<E extends ElementType> = {
  as?: E;
  /** "grid" exposes a 12-column grid to children via grid-column. */
  layout?: "block" | "grid";
  className?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<E>, "as" | "className" | "children">;

/** Page-width wrapper with the shared gutter. */
export function Container<E extends ElementType = "div">({
  as,
  layout = "block",
  className,
  children,
  ...rest
}: ContainerProps<E>) {
  const Component: ElementType = as ?? "div";
  return (
    <Component
      className={[styles.container, layout === "grid" && styles.grid, className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </Component>
  );
}
