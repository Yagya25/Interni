"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ButtonLink } from "@/components/Button";
import { Wordmark } from "@/components/Wordmark";
import { anchors, routes, site } from "@/config/site";
import { chapters } from "../sequence/chapters";
import { sequenceStore, useChapterIndex } from "../sequence/store";
import styles from "./SiteNav.module.css";

/**
 * On the cover the navigation offers two ways in. Once the story starts it
 * steps back: the links give way to the current chapter, and the only
 * persistent action is the way into the product.
 */
export function SiteNav() {
  const chapter = useChapterIndex();
  const inStory = chapter >= 0 && chapter < chapters.length;
  const current = inStory ? chapters[chapter] : null;
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);

  useEffect(
    () =>
      sequenceStore.onProgress((progress) => {
        if (progressRef.current) progressRef.current.style.transform = `scaleX(${progress.toFixed(4)})`;
      }),
    [],
  );

  // Menu: focus in, Escape out, background locked.
  useEffect(() => {
    if (!open) return;
    const button = menuButtonRef.current;
    firstItemRef.current?.focus();
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      root.style.overflow = previous;
      button?.focus();
    };
  }, [open]);

  const goTo = (index: number) => {
    setOpen(false);
    // Let the scroll lock release before scrolling.
    requestAnimationFrame(() => sequenceStore.seek(index));
  };

  return (
    <header className={styles.nav} data-in-story={inStory} data-open={open} data-print="hide">
      <div className={styles.bar}>
        <Link href={routes.home} className={styles.brand} aria-label={`${site.name}, back to the start`}>
          <Wordmark />
        </Link>

        <div className={styles.middle}>
          <nav className={styles.links} aria-label="Primary">
            <a href={`#${anchors.sequence}`}>How it works</a>
            <a href={`#${anchors.reimagine}`}>Reimagine</a>
          </nav>
          <p className={styles.chapter} aria-hidden="true">
            {current && (
              <>
                <span className={styles.chapterIndex}>{current.index}</span>
                <span>{current.label}</span>
              </>
            )}
          </p>
        </div>

        <div className={styles.actions}>
          <ButtonLink href={routes.workspace} arrow className={styles.cta}>
            Try it now
          </ButtonLink>
          <button
            ref={menuButtonRef}
            type="button"
            className={styles.menuButton}
            aria-expanded={open}
            aria-controls="site-menu"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>

      <span className={styles.progress} aria-hidden="true">
        <span ref={progressRef} className={styles.progressFill} />
      </span>

      <div id="site-menu" className={styles.menu} hidden={!open}>
        <p className={styles.menuKicker}>The walkthrough</p>
        <ol className={styles.menuList}>
          {chapters.map((c, i) => (
            <li key={c.id}>
              <button
                ref={i === 0 ? firstItemRef : undefined}
                type="button"
                className={styles.menuItem}
                aria-current={i === chapter ? "step" : undefined}
                onClick={() => goTo(i)}
              >
                <span className={styles.menuIndex}>{c.index}</span>
                <span>{c.label}</span>
              </button>
            </li>
          ))}
        </ol>
        <ButtonLink href={routes.workspace} size="l" arrow className={styles.menuCta}>
          Try it now
        </ButtonLink>
      </div>
    </header>
  );
}
