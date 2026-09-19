import Link from "next/link";
import { Container } from "@/components/Container";
import { Wordmark } from "@/components/Wordmark";
import { routes, site } from "@/config/site";
import styles from "./SiteFooter.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <Container layout="grid" className={styles.grid}>
        <div className={styles.brand}>
          <Wordmark />
          <p className={styles.statement}>
            {site.name} turns a photograph of a room into a model you can redesign.
          </p>
        </div>
        <p className={styles.note}>
          The room on this page is a hand-built demonstration scene. Its measurements, objects and
          materials illustrate the kind of model {site.name} produces; they are not the output of an
          analysis.
        </p>
        <nav className={styles.links} aria-label="Footer">
          <Link href={routes.workspace}>Workspace</Link>
          <a href="#top">Back to the start</a>
        </nav>
        <p className={styles.legal} suppressHydrationWarning>
          © {new Date().getFullYear()} {site.name}
        </p>
      </Container>
    </footer>
  );
}
