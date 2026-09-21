import { demo } from "@/demo";
import { chapters } from "../chapters";
import styles from "./layers.module.css";

const { summary } = demo;

/** What the understanding chapter leads with: counts read from the scene. */
const counts = [
  { value: summary.objects, label: summary.objects === 1 ? "object" : "objects" },
  {
    value: summary.surfaces,
    label: summary.surfaces === 1 ? "surface" : "surfaces",
    note: summary.inferredSurfaces ? `${summary.inferredSurfaces} inferred` : undefined,
  },
  { value: summary.lightSources, label: summary.lightSources === 1 ? "light source" : "light sources" },
];

/**
 * Every chapter's words, in document order. Visibility is choreographed by
 * the timeline; screen readers get the whole story as a sequence of
 * headings regardless of scroll position.
 *
 * A chapter is one statement. Short ones ("Depth.") are set as large as the
 * room allows; sentences a step smaller, so neither crowds the picture.
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
          {chapter.id === "understanding" ? (
            <>
              <h2 id={`chapter-${chapter.id}`} className="visually-hidden">
                {chapter.title}
              </h2>
              <dl className={styles.counts}>
                {counts.map((count) => (
                  <div key={count.label} className={styles.count}>
                    <dt className={styles.countLabel} data-rise>
                      {count.label}
                      {count.note && <span className={styles.countNote}> ({count.note})</span>}
                    </dt>
                    <dd className={styles.countValue}>
                      <span className={styles.mask}>
                        <span data-mask>{count.value}</span>
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <h2
              id={`chapter-${chapter.id}`}
              className={styles.chapterTitle}
              data-scale={chapter.title.split(" ").length > 3 ? "sentence" : "statement"}
            >
              <span className={styles.mask}>
                <span data-mask>{chapter.title}</span>
              </span>
            </h2>
          )}
          <p className={styles.chapterBody} data-rise>
            {chapter.body}
          </p>
        </article>
      ))}
    </div>
  );
}
