import { ButtonLink } from "@/components/Button";
import { routes } from "@/config/site";
import styles from "./layers.module.css";

/** The redesigned room gets a moment, then the invitation. */
export function Closing() {
  return (
    <section className={styles.closing} data-layer="closing" aria-labelledby="closing-title">
      <h2 id="closing-title" className={styles.closingTitle}>
        <span className={styles.mask}>
          <span data-mask>Your space.</span>
        </span>
        <span className={styles.mask}>
          <span data-mask>Understood.</span>
        </span>
      </h2>
      <div className={styles.closingAction}>
        <p className={styles.closingLine} data-rise>
          Now make it yours.
        </p>
        <div data-rise>
          <ButtonLink href={routes.workspace} size="l" arrow>
            Try it now
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
