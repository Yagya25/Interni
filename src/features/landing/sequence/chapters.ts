import { demo } from "@/demo";

/**
 * The story, in order. `span` is the chapter's length on the scroll
 * timeline in abstract units; `settle` is the fraction of the span at which
 * everything in the chapter is fully shown (used for reduced motion and
 * chapter navigation).
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
  | "edit"
  | "space"
  | "understanding"
  | "reimagine";

const { summary } = demo;

export const chapters: readonly Chapter[] = [
  {
    id: "photo",
    index: "01",
    label: "Photograph",
    title: "Start with a photo.",
    body: "One ordinary picture of a room. No scanner, no tape measure.",
    span: 8,
    settle: 0.5,
  },
  {
    id: "depth",
    index: "02",
    label: "Depth",
    title: "We see depth.",
    body: "Every point gets a distance from the camera. A line for each quarter metre.",
    span: 12,
    settle: 0.72,
  },
  {
    id: "structure",
    index: "03",
    label: "Structure",
    title: "The room becomes structure.",
    body: "Walls, floor, ceiling, windows and door, pulled apart the way an architect would draw them.",
    span: 14,
    settle: 0.62,
  },
  {
    id: "objects",
    index: "04",
    label: "Objects",
    title: "Then everything in it.",
    body: `${summary.objects} objects, each with a position, a footprint and a size.`,
    span: 12,
    settle: 0.55,
  },
  {
    id: "materials",
    index: "05",
    label: "Materials",
    title: "Materials become editable.",
    body: "Oak, linen, marble, glass, steel, leather, paint. Each surface knows what it is made of.",
    span: 12,
    settle: 0.78,
  },
  {
    id: "light",
    index: "06",
    label: "Light",
    title: "Light becomes a system.",
    body: "Window light, ambient light and two lamps, each its own source. Change the hour and the room follows.",
    span: 14,
    settle: 0.45,
  },
  {
    id: "edit",
    index: "07",
    label: "Edit",
    title: "Now it can change.",
    body: "Move the table. Swap the chair. Reupholster the sofa. Bring the afternoon back.",
    span: 16,
    settle: 0.95,
  },
  {
    id: "space",
    index: "08",
    label: "Space",
    title: "From image to space.",
    body: "The photograph was one point of view. The model is the whole room.",
    span: 12,
    settle: 0.7,
  },
  {
    id: "understanding",
    index: "09",
    label: "Understanding",
    title: "What it understands.",
    body: "Everything the model holds about this room, in one place.",
    span: 12,
    settle: 0.62,
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
export const OUTRO_SPAN = 13;

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
export const VH_PER_UNIT = 8.5;

export const chapterAt = (time: number): number => {
  if (time < INTRO_SPAN * 0.6) return -1;
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (time >= timings[chapters[i].id].start - 0.5) return i;
  }
  return 0;
};
