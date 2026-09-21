import { demo } from "@/demo";

/**
 * The story, in order. `span` is the chapter's length on the scroll
 * timeline in abstract units; `settle` is the fraction of the span at which
 * everything in the chapter is fully shown (used for reduced motion and
 * chapter navigation).
 *
 * Each chapter says one thing. `title` is the statement set large over the
 * room; `body` is a single supporting line.
 */
export interface Chapter {
  id: ChapterId;
  index: string;
  label: string;
  title: string;
  body: string;
  span: number;
  settle: number;
}

export type ChapterId =
  | "photo"
  | "depth"
  | "structure"
  | "objects"
  | "materials"
  | "light"
  | "space"
  | "understanding"
  | "edit"
  | "reimagine";

const { summary } = demo;

export const chapters: readonly Chapter[] = [
  {
    id: "photo",
    index: "01",
    label: "Photograph",
    title: "We turn it into something AI can understand.",
    body: "One ordinary photograph. No scanner, no tape measure.",
    span: 10,
    settle: 0.45,
  },
  {
    id: "depth",
    index: "02",
    label: "Depth",
    title: "Depth.",
    body: "Every point in the picture gets a distance. A line for each quarter metre.",
    span: 12,
    settle: 0.7,
  },
  {
    id: "structure",
    index: "03",
    label: "Structure",
    title: "Structure.",
    body: "Walls, floor, ceiling and openings, each pulled free as its own surface.",
    span: 14,
    settle: 0.62,
  },
  {
    id: "objects",
    index: "04",
    label: "Objects",
    title: "Objects.",
    body: `${summary.objects} pieces, lifted out of the picture. The blanks are what the camera never saw.`,
    span: 13,
    settle: 0.55,
  },
  {
    id: "materials",
    index: "05",
    label: "Materials",
    title: "Materials.",
    body: "Oak, linen, marble, glass, steel, leather, paint. Each surface knows what it is made of.",
    span: 12,
    settle: 0.8,
  },
  {
    id: "light",
    index: "06",
    label: "Light",
    title: "Light.",
    body: "Daylight through two windows, two lamps, the sky. Change the hour and the room follows.",
    span: 14,
    settle: 0.45,
  },
  {
    id: "space",
    index: "07",
    label: "Space",
    title: "A place, not a picture.",
    body: "The photograph had one point of view. The model has all of them.",
    span: 15,
    settle: 0.5,
  },
  {
    id: "understanding",
    index: "08",
    label: "Understanding",
    title: "What it understands.",
    body: "Measured, named and related: everything the model holds about this room.",
    span: 12,
    settle: 0.6,
  },
  {
    id: "edit",
    index: "09",
    label: "Edit",
    title: "Now it’s editable.",
    body: "Move the table. Swap the chair. Reupholster the sofa. Change the hour.",
    span: 16,
    settle: 0.95,
  },
  {
    id: "reimagine",
    index: "10",
    label: "Reimagine",
    title: "Now reimagine it.",
    body: "One design direction, applied to furniture, materials, colour and light together.",
    span: 18,
    settle: 0.88,
  },
];

/** Hero → first chapter, and the closing moment after the last. */
export const INTRO_SPAN = 6;
export const OUTRO_SPAN = 12;

export interface ChapterTiming {
  start: number;
  end: number;
  settle: number;
}

export const timings: Record<ChapterId, ChapterTiming> = (() => {
  let cursor = INTRO_SPAN;
  const out = {} as Record<ChapterId, ChapterTiming>;
  for (const chapter of chapters) {
    out[chapter.id] = {
      start: cursor,
      end: cursor + chapter.span,
      settle: cursor + chapter.span * chapter.settle,
    };
    cursor += chapter.span;
  }
  return out;
})();

export const OUTRO_START = timings.reimagine.end;
export const TOTAL_SPAN = OUTRO_START + OUTRO_SPAN;
/** The closing frame, fully composed. */
export const OUTRO_SETTLE = OUTRO_START + OUTRO_SPAN * 0.72;

/** Scroll distance per timeline unit, in viewport heights. */
export const VH_PER_UNIT = 7.5;

export const chapterAt = (time: number): number => {
  if (time < INTRO_SPAN * 0.6) return -1;
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (time >= timings[chapters[i].id].start - 0.5) return i;
  }
  return 0;
};
