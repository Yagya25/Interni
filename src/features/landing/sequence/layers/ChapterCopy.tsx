import { chapters } from "../chapters";
import styles from "./layers.module.css";

/**
 * Every chapter's words, in document order. Visibility is choreographed by
 * the timeline; screen readers get the whole story as a sequence of
 * headings regardless of scroll position.
 */
export function ChapterCopy() {
  return (
    <div className={styles.chapters}>
      <div className={styles.scrim} data-scrim aria-hidden="true" />
      {chapters.map((chapter) => (
        <article
          key={chapter.id}
          className={styles.chapter}
          data-chapter={chapter.id}
          aria-labelledby={`chapter-${chapter.id}`}
        >
          <p className={styles.chapterIndex} data-rise>
            <span>{chapter.index}</span>
            <span>{chapter.label}</span>
          </p>
          <h2 id={`chapter-${chapter.id}`} className={styles.chapterTitle}>
            <span className={styles.mask}>
              <span data-mask>{chapter.title}</span>
            </span>
          </h2>
          <p className={styles.chapterBody} data-rise>
            {chapter.body}
          </p>
        </article>
      ))}
    </div>
  );
}
