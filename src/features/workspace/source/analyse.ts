import type { Analysis, Problem } from "./types";

/**
 * What can honestly be learned from a photograph in a browser.
 *
 * This decodes the image, measures it, and samples the colour and tone
 * actually present in the pixels. That is all — and every number it
 * produces is a measurement, not an inference. It finds no walls, no
 * furniture and no light sources, because nothing here can.
 *
 * The tones it returns are genuinely the room's own colours, which is why
 * they are worth showing: they are the first real thing the system knows
 * about a space somebody brought it.
 */

export const ACCEPTED = ["image/jpeg", "image/png", "image/webp"] as const;
export const ACCEPT_ATTRIBUTE = ACCEPTED.join(",");
export const MAX_BYTES = 24 * 1024 * 1024;
/** Below this, depth and layout would have too little to work from. */
export const MIN_EDGE = 640;

/** The sample is reduced to this edge before counting; enough for tone. */
const SAMPLE_EDGE = 64;
/** Levels per channel when grouping colours, so near-identical tones merge. */
const BUCKETS = 4;
const TONE_COUNT = 6;

export type Decoded = { width: number; height: number; analysis: Analysis };

export type Outcome = { ok: true; decoded: Decoded } | { ok: false; problem: Problem };

export function check(file: File): Problem | null {
  if (!(ACCEPTED as readonly string[]).includes(file.type)) return "type";
  if (file.size > MAX_BYTES) return "size";
  return null;
}

/**
 * Decode and measure. `onStep` reports the real stage reached, so the
 * interface can show what is happening rather than a decorative timer.
 */
export async function analyse(blob: Blob, onStep: (step: number) => void): Promise<Outcome> {
  onStep(1);
  const url = URL.createObjectURL(blob);
  try {
    const image = await decode(url);
    if (Math.min(image.naturalWidth, image.naturalHeight) < MIN_EDGE) {
      return { ok: false, problem: "small" };
    }

    onStep(2);
    const { naturalWidth: width, naturalHeight: height } = image;

    onStep(3);
    const pixels = reduce(image);
    if (!pixels) return { ok: false, problem: "unreadable" };

    return {
      ok: true,
      decoded: {
        width,
        height,
        analysis: { ...measure(pixels), megapixels: (width * height) / 1e6, aspect: width / height },
      },
    };
  } catch {
    return { ok: false, problem: "unreadable" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decoding is the only proof that a file really is the image it claims. */
function decode(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode failed"));
    image.src = url;
  });
}

/** Draw the image small; counting every pixel of a 12MP photograph is waste. */
function reduce(image: HTMLImageElement): ImageData | null {
  const scale = SAMPLE_EDGE / Math.max(image.naturalWidth, image.naturalHeight);
  const w = Math.max(1, Math.round(image.naturalWidth * scale));
  const h = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, w, h);
  try {
    return ctx.getImageData(0, 0, w, h);
  } catch {
    // A cross-origin image would taint the canvas; a local file cannot.
    return null;
  }
}

function measure(pixels: ImageData): Omit<Analysis, "megapixels" | "aspect"> {
  const { data } = pixels;
  const count = data.length / 4;
  const luminances: number[] = [];
  /** Bucket key → running total, so a swatch is a real average colour. */
  const groups = new Map<number, { r: number; g: number; b: number; n: number }>();

  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    luminances.push((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
    const key = bucket(r) * BUCKETS * BUCKETS + bucket(g) * BUCKETS + bucket(b);
    const group = groups.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    group.r += r;
    group.g += g;
    group.b += b;
    group.n += 1;
    groups.set(key, group);
  }

  luminances.sort((a, b) => a - b);
  const at = (share: number) => luminances[Math.floor((luminances.length - 1) * share)];

  const tones = [...groups.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, TONE_COUNT)
    .map((group) => ({
      color: hex(group.r / group.n, group.g / group.n, group.b / group.n),
      share: group.n / count,
    }));

  return {
    luminance: luminances.reduce((sum, value) => sum + value, 0) / luminances.length,
    range: [at(0.02), at(0.98)],
    tones,
    sampled: count,
  };
}

const bucket = (value: number) => Math.min(BUCKETS - 1, Math.floor((value / 256) * BUCKETS));

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const PROBLEMS: Record<Problem, { title: string; detail: string }> = {
  type: {
    title: "That file isn't a photograph this can read.",
    detail: "A JPG, PNG or WEBP of the room, straight from a phone or camera.",
  },
  size: {
    title: "That file is too large.",
    detail: `Up to ${Math.round(MAX_BYTES / 1024 / 1024)} MB. Most phone photographs are well under it.`,
  },
  unreadable: {
    title: "That image couldn't be opened.",
    detail: "The file may be damaged, or may not be the format its name suggests.",
  },
  small: {
    title: "That image is too small to work from.",
    detail: `At least ${MIN_EDGE} pixels on the shorter edge, so the walls and furniture can be made out.`,
  },
  storage: {
    title: "The photograph couldn't be kept for next time.",
    detail:
      "This browser is refusing local storage, which private windows often do. It still works for this visit.",
  },
};
