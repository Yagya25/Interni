import { ButtonLink } from "@/components/Button";
import { routes } from "@/config/site";
import styles from "./layers.module.css";

/** The redesigned room settles into a photograph again, then the invitation. */
export function Closing() {
  return (
    <section className={styles.closing} data-layer="closing" aria-labelledby="closing-title">
      <h2 id="closing-title" className={styles.closingTitle}>
        <span className={styles.mask}>
          <span data-mask>Now make</span>
        </span>
        <span className={styles.mask}>
          <span data-mask>it yours.</span>
        </span>
      </h2>
      <div className={styles.closingAction}>
        <p className={styles.closingLine} data-rise>
          Start from a photograph of your own room, or open the demonstration space.
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
