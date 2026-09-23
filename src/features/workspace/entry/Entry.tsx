"use client";

import { useEffect, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/Button";
import { Text } from "@/components/Text";
import { routes } from "@/config/site";
import { ACCEPT_ATTRIBUTE, formatBytes, PROBLEMS } from "../source/analyse";
import { ANALYSIS_STEPS, RECONSTRUCTION_STAGES, type SourceStatus } from "../source/types";
import { useSource } from "../source/useSource";
import styles from "./Entry.module.css";

const DEMO_ROUTE = `${routes.workspace}/demo`;
/** The existing list of rooms the local reconstruction worker has built. */
const RECONSTRUCTION_ROUTE = `${routes.workspace}/reconstruction`;

/**
 * The door into the product.
 *
 * Two ways in, kept apart on purpose. A photograph somebody brings is
 * theirs: it goes on screen the moment it is chosen and stays there, and
 * everything said about it afterwards was actually measured from it. The
 * demonstration room is a different thing entirely, reached only by
 * asking for it, and never shown as though it came from their picture.
 */
export function Entry() {
  const { state, blob, take, discard } = useSource();
  const [over, setOver] = useState(false);
  const plateRef = useRef<HTMLImageElement | null>(null);

  /**
   * An object URL is a browser resource, not React state, so the effect
   * that creates one points the image at it and releases it on the way
   * out. Each run frees only what that run made, so swapping the
   * photograph, leaving the page and React's development double-run all
   * leave nothing behind.
   */
  useEffect(() => {
    const plate = plateRef.current;
    if (!blob || !plate) return;
    const url = URL.createObjectURL(blob);
    plate.src = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  const reading = state.status === "uploading" || state.status === "analyzing";
  const photograph = state.status === "ready" || state.status === "uploaded" ? state.photograph : null;
  /** Steps finished. While reading, the current step is the one in hand. */
  const done = reading
    ? state.step - 1
    : state.status === "ready"
      ? ANALYSIS_STEPS.length
      : state.status === "uploaded"
        ? // Held from a previous visit: read and decoded, never sampled.
          ANALYSIS_STEPS.length - 1
        : 0;

  const heading = (
    <header className={styles.head}>
      <Text as="p" variant="label" tone="muted">
        Your space
      </Text>
      <Text as="h1" variant="display-m" className={styles.title}>
        {HEADINGS[state.status]}
      </Text>
      <Text as="p" variant="body-l" tone="muted" className={styles.lede}>
        {LEDES[state.status]}
      </Text>
      {photograph && (
        <p className={styles.status} role="status">
          <span className={styles.statusMark} aria-hidden="true" />
          Ready for reconstruction
          <span className={styles.statusNote}>Reconstruction is not connected yet</span>
        </p>
      )}
    </header>
  );

  return (
    <div className={styles.entry} data-held={blob ? "" : undefined}>
      {!blob && heading}

      {blob ? (
        <>
          <section className={styles.held} aria-label="Your photograph">
            <figure className={styles.plate}>
              {/* A blob from this session: there is nothing for the image
                  optimiser to fetch, resize or cache. Shown whole, never
                  cropped, whichever way the photograph was taken. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img ref={plateRef} alt="The room you brought in" className={styles.image} />
              <figcaption className={styles.caption}>
                <span>Your photograph</span>
                {photograph && (
                  <span>
                    {photograph.width} × {photograph.height}
                  </span>
                )}
                <span>Kept in this browser. It has not been uploaded anywhere.</span>
              </figcaption>
            </figure>

            <div className={styles.aside}>
              {/* Beside the photograph rather than above it: the picture is
                  what this page is about, so it takes the first view. */}
              {heading}
              {reading ? (
                <ol className={styles.steps} aria-label="Reading the photograph">
                  {ANALYSIS_STEPS.map((label, index) => (
                    <li key={label} data-state={index < done ? "done" : index === done ? "now" : "next"}>
                      {label}
                    </li>
                  ))}
                </ol>
              ) : (
                <section className={styles.block} aria-labelledby="measured-title">
                  <h2 id="measured-title" className={styles.blockTitle}>
                    Measured from your image
                  </h2>
                  {photograph && (
                    <dl className={styles.facts}>
                      <Fact label="File" value={photograph.name} />
                      <Fact label="Size" value={formatBytes(photograph.bytes)} />
                      <Fact
                        label="Pixels"
                        value={`${photograph.width} × ${photograph.height} · ${((photograph.width * photograph.height) / 1e6).toFixed(1)} MP`}
                      />
                      {state.status === "ready" && (
                        <Fact
                          label="Tone"
                          value={`${percent(state.analysis.range[0])}–${percent(state.analysis.range[1])}, mean ${percent(state.analysis.luminance)}`}
                        />
                      )}
                    </dl>
                  )}
                  {state.status === "ready" && (
                    <div className={styles.tones}>
                      <p className={styles.tonesLabel}>
                        Colours in your photograph
                        <span>{state.analysis.sampled.toLocaleString()} points</span>
                      </p>
                      <ul className={styles.swatches}>
                        {state.analysis.tones.map((tone) => (
                          <li key={tone.color} style={{ background: tone.color }}>
                            <span className="visually-hidden">
                              {tone.color}, {percent(tone.share)} of the image
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}

              <section className={styles.block} aria-labelledby="pipeline-title">
                <h2 id="pipeline-title" className={styles.blockTitle}>
                  Reconstruction
                  <span className={styles.offline}>Not connected yet</span>
                </h2>
                <ol className={styles.pipeline}>
                  <li data-state={reading ? "now" : "done"}>Photograph received and measured</li>
                  {RECONSTRUCTION_STAGES.map((stage) => (
                    <li key={stage} data-state="waiting">
                      {stage}
                    </li>
                  ))}
                </ol>
                <ButtonLink href={RECONSTRUCTION_ROUTE} aria-describedby="pipeline-note" className={styles.reconstruct}>
                  Open room reconstructions
                </ButtonLink>
                <p id="pipeline-note" className={styles.honest}>
                  Rooms are reconstructed by the reconstruction worker on this machine, and its finished
                  runs open from there. This photograph stays in this browser: it has not been sent to
                  the worker, so nothing has been detected in it yet.
                </p>
              </section>

              <div className={styles.actions}>
                <label className={styles.replace}>
                  <input
                    type="file"
                    className="visually-hidden"
                    accept={ACCEPT_ATTRIBUTE}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void take(file);
                      event.target.value = "";
                    }}
                  />
                  Replace photograph
                </label>
                <Button variant="text" onClick={discard}>
                  Remove
                </Button>
              </div>
            </div>
          </section>

          <aside className={styles.elsewhere} aria-label="The demonstration room">
            <span className={styles.rule} aria-hidden="true" />
            <Text as="p" variant="small" tone="muted">
              Want to see what a reconstructed room can do in the meantime? The demonstration room is a
              complete, editable space — a room we built, not yours.
            </Text>
            <ButtonLink href={DEMO_ROUTE} variant="line" arrow>
              Open the demonstration room
            </ButtonLink>
          </aside>
        </>
      ) : (
        <section className={styles.choose}>
          <label
            className={styles.drop}
            data-over={over || undefined}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              const file = event.dataTransfer.files[0];
              if (file) void take(file);
            }}
          >
            <input
              type="file"
              className={styles.input}
              accept={ACCEPT_ATTRIBUTE}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void take(file);
              }}
            />
            <span className={styles.dropMark} aria-hidden="true">
              <svg viewBox="0 0 48 36" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="0.6" y="0.6" width="46.8" height="34.8" strokeDasharray="4 3" />
                <path d="M6 29l11-13 8 9 6-6 11 10" />
                <circle cx="15" cy="11" r="3.2" />
              </svg>
            </span>
            <span className={styles.dropTitle}>Drop a room photograph here</span>
            <span className={styles.dropOr}>or choose an image</span>
            <span className={styles.dropFormats}>JPG · PNG · WEBP</span>
          </label>

          {state.status === "error" && (
            <div className={styles.problem} role="alert">
              <p className={styles.problemTitle}>{PROBLEMS[state.problem].title}</p>
              <p className={styles.problemDetail}>{PROBLEMS[state.problem].detail}</p>
            </div>
          )}

          <div className={styles.alternative}>
            <span className={styles.rule} aria-hidden="true" />
            <Text as="p" variant="small" tone="muted">
              Nothing to hand? The demonstration room is a complete, editable space — a room we
              built, not one of yours.
            </Text>
            <ButtonLink href={DEMO_ROUTE} variant="line" arrow>
              Open demo room
            </ButtonLink>
          </div>
        </section>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

// Exhaustive by type: a new state cannot ship without words for it.
const HEADINGS: Record<SourceStatus, string> = {
  empty: "Bring in a room to begin.",
  uploading: "Reading your photograph.",
  analyzing: "Looking at your photograph.",
  uploaded: "This is your space.",
  ready: "This is your space.",
  reconstructing: "Building your room.",
  reconstructed: "Your room is ready.",
  error: "Bring in a room to begin.",
};

const LEDES: Record<SourceStatus, string> = {
  empty:
    "One photograph, taken from a corner of the room at about eye height, with as much of the floor and two walls in shot as you can manage.",
  uploading: "Reading the file, here in this browser. It is not being uploaded anywhere.",
  analyzing: "Measuring the image itself. Nothing is being guessed about the room yet.",
  uploaded:
    "Your photograph, held from an earlier visit, is the source of this space. Turning it into a room you can edit — walls, objects, materials and light — needs the reconstruction pipeline, which isn’t connected yet.",
  ready:
    "Your photograph is the source of this space. Turning it into a room you can edit — walls, objects, materials and light — needs the reconstruction pipeline, which isn’t connected yet.",
  reconstructing: "",
  reconstructed: "",
  error: "That one didn’t work. Try another.",
};
