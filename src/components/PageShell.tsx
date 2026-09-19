import Link from "next/link";
import type { ReactNode } from "react";
import { anchors, routes, site } from "@/config/site";
import { Wordmark } from "./Wordmark";
import styles from "./PageShell.module.css";

/** Minimal frame for secondary pages: wordmark, content, nothing else. */
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href={routes.home} className={styles.brand} aria-label={`${site.name}, home`}>
          <Wordmark />
        </Link>
      </header>
      <main id={anchors.main} tabIndex={-1} className={styles.main}>
        {children}
      </main>
    </div>
  );
}
