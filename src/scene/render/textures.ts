import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";
import type { SurfacePattern } from "@/scene/model/types";

/**
 * Procedural surface detail, drawn once on a canvas.
 *
 * Every texture is a near-white detail map that the material colour tints,
 * so one pattern serves any colour and a material edit is only a colour
 * change. Generation is seeded: the room looks identical on every load.
 */

type Draw = (ctx: CanvasRenderingContext2D, size: number, rand: () => number) => void;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a `cells` × `cells` lattice. */
function createNoise(rand: () => number, cells: number) {
  const grid = new Float32Array(cells * cells).map(() => rand());
  const at = (x: number, y: number) =>
    grid[(((y % cells) + cells) % cells) * cells + (((x % cells) + cells) % cells)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (u: number, v: number) => {
    const x = u * cells;
    const y = v * cells;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * tx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * tx;
    return a + (b - a) * ty;
  };
}

function fbm(rand: () => number, octaves: number, base: number) {
  const layers = Array.from({ length: octaves }, (_, i) => createNoise(rand, base * 2 ** i));
  return (u: number, v: number) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (const layer of layers) {
      sum += layer(u, v) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

const grey = (value: number, alpha = 1) => {
  const v = Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgba(${v},${v},${v},${alpha})`;
};

/** Per-pixel fill helper for noise-driven patterns. */
function paintPixels(
  ctx: CanvasRenderingContext2D,
  size: number,
  shade: (u: number, v: number) => number,
) {
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.round(Math.min(1, Math.max(0, shade(x / size, y / size))) * 255);
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Thin fibres running along X, used for wood grain inside a region. */
function grainLines(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  x: number,
  y: number,
  w: number,
  h: number,
  density: number,
  strength: number,
) {
  const count = Math.floor(h * density);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let i = 0; i < count; i++) {
    const yy = y + rand() * h;
    const amp = 0.6 + rand() * 2.2;
    const freq = 0.004 + rand() * 0.01;
    const phase = rand() * Math.PI * 2;
    ctx.strokeStyle = grey(rand() < 0.5 ? 0.62 : 0.78, strength * (0.35 + rand() * 0.65));
    ctx.lineWidth = 0.5 + rand() * 1.1;
    ctx.beginPath();
    for (let xx = x; xx <= x + w; xx += 8) {
      const py = yy + Math.sin(xx * freq + phase) * amp;
      if (xx === x) ctx.moveTo(xx, py);
      else ctx.lineTo(xx, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

const patterns: Record<Exclude<SurfacePattern, "none">, { size: number; draw: Draw }> = {
  planks: {
    size: 1024,
    draw(ctx, size, rand) {
      const rows = 13;
      const rowH = size / rows;
      for (let r = 0; r < rows; r++) {
        let x = -rand() * size * 0.6;
        while (x < size) {
          const len = size * (0.45 + rand() * 0.55);
          const tone = 0.82 + rand() * 0.16;
          ctx.fillStyle = grey(tone);
          ctx.fillRect(x, r * rowH, len, rowH);
          grainLines(ctx, rand, x, r * rowH, len, rowH, 0.9, 0.5);
          ctx.fillStyle = grey(0.45, 0.55);
          ctx.fillRect(x, r * rowH, 1.5, rowH);
          // Wrap planks across the seam so the texture tiles.
          if (x + len > size) {
            ctx.fillStyle = grey(tone);
            ctx.fillRect(x - size, r * rowH, len, rowH);
            grainLines(ctx, rand, x - size, r * rowH, len, rowH, 0.9, 0.5);
          }
          x += len;
        }
        ctx.fillStyle = grey(0.42, 0.7);
        ctx.fillRect(0, r * rowH, size, 1.5);
      }
    },
  },
  chevron: {
    size: 1024,
    draw(ctx, size, rand) {
      const columns = 6;
      const colW = size / columns;
      const plankH = size / 16;
      for (let c = 0; c < columns; c++) {
        const x0 = c * colW;
        const dir = c % 2 === 0 ? 1 : -1;
        for (let y = -colW - plankH; y < size + colW; y += plankH) {
          const tone = 0.78 + rand() * 0.2;
          ctx.fillStyle = grey(tone);
          ctx.beginPath();
          const yA = dir > 0 ? y : y + colW;
          const yB = dir > 0 ? y + colW : y;
          ctx.moveTo(x0, yA);
          ctx.lineTo(x0 + colW, yB);
          ctx.lineTo(x0 + colW, yB + plankH);
          ctx.lineTo(x0, yA + plankH);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = grey(0.4, 0.6);
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
      // Grain as fine diagonal hatching.
      ctx.globalAlpha = 0.18;
      for (let i = 0; i < 1400; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const col = Math.floor(x / colW);
        const dir = col % 2 === 0 ? 1 : -1;
        ctx.strokeStyle = grey(0.55);
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 18, y + dir * 18);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  },
  grain: {
    size: 512,
    draw(ctx, size, rand) {
      ctx.fillStyle = grey(0.9);
      ctx.fillRect(0, 0, size, size);
      grainLines(ctx, rand, 0, 0, size, size, 0.55, 0.7);
    },
  },
  weave: {
    size: 256,
    draw(ctx, size, rand) {
      // Fine plain weave with only a faint slub: fabric reads as texture
      // at arm's length, not as blotches across the room.
      const slub = fbm(rand, 2, 16);
      paintPixels(ctx, size, (u, v) => {
        const warp = Math.sin(u * size * Math.PI * 0.5) * 0.5 + 0.5;
        const weft = Math.sin(v * size * Math.PI * 0.5) * 0.5 + 0.5;
        return 0.95 + (slub(u, v) - 0.5) * 0.05 - warp * weft * 0.06;
      });
    },
  },
  boucle: {
    size: 256,
    draw(ctx, size, rand) {
      ctx.fillStyle = grey(0.94);
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 4200; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const r = 0.8 + rand() * 1.6;
        ctx.fillStyle = grey(rand() < 0.5 ? 0.82 : 1, 0.5);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  jute: {
    size: 512,
    draw(ctx, size, rand) {
      // Basket weave: pairs of heavy yarns alternating direction.
      const cells = 40;
      const cell = size / cells;
      for (let y = 0; y < cells; y++) {
        for (let x = 0; x < cells; x++) {
          const horizontal = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0;
          ctx.fillStyle = grey(0.86 + rand() * 0.1);
          ctx.fillRect(x * cell, y * cell, cell, cell);
          ctx.strokeStyle = grey(0.66, 0.5);
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (horizontal) {
            ctx.moveTo(x * cell, y * cell + cell / 2);
            ctx.lineTo((x + 1) * cell, y * cell + cell / 2);
          } else {
            ctx.moveTo(x * cell + cell / 2, y * cell);
            ctx.lineTo(x * cell + cell / 2, (y + 1) * cell);
          }
          ctx.stroke();
        }
      }
    },
  },
  veined: {
    size: 512,
    draw(ctx, size, rand) {
      const turbulence = fbm(rand, 5, 3);
      const cloud = fbm(rand, 3, 2);
      paintPixels(ctx, size, (u, v) => {
        const t = turbulence(u, v);
        const vein = Math.abs(Math.sin((u + v * 0.6 + t * 1.6) * Math.PI * 3));
        const fine = Math.abs(Math.sin((u * 0.4 - v + t * 2.4) * Math.PI * 7));
        const line = Math.pow(1 - vein, 14) * 0.5 + Math.pow(1 - fine, 30) * 0.22;
        return 0.97 - line + (cloud(u, v) - 0.5) * 0.06;
      });
    },
  },
  travertine: {
    size: 512,
    draw(ctx, size, rand) {
      const band = fbm(rand, 4, 4);
      paintPixels(ctx, size, (u, v) => {
        const b = band(u * 0.25, v);
        return 0.86 + Math.sin(v * Math.PI * 18 + b * 6) * 0.04 + (b - 0.5) * 0.12;
      });
      for (let i = 0; i < 220; i++) {
        ctx.fillStyle = grey(0.62, 0.55);
        ctx.beginPath();
        ctx.ellipse(rand() * size, rand() * size, 1 + rand() * 4, 0.5 + rand() * 1.2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  limewash: {
    size: 512,
    draw(ctx, size, rand) {
      const cloud = fbm(rand, 5, 3);
      const brush = fbm(rand, 3, 12);
      paintPixels(ctx, size, (u, v) => {
        return 0.87 + (cloud(u, v) - 0.5) * 0.22 + (brush(u, v * 0.4) - 0.5) * 0.06;
      });
    },
  },
  plaster: {
    size: 512,
    draw(ctx, size, rand) {
      const cloud = fbm(rand, 4, 4);
      paintPixels(ctx, size, (u, v) => 0.95 + (cloud(u, v) - 0.5) * 0.07);
    },
  },
  canvas: {
    size: 256,
    draw(ctx, size, rand) {
      const n = fbm(rand, 2, 16);
      paintPixels(ctx, size, (u, v) => {
        const weave = Math.sin(u * size * Math.PI) * Math.sin(v * size * Math.PI) * 0.03;
        return 0.93 + weave + (n(u, v) - 0.5) * 0.06;
      });
    },
  },
  // Four by four square tiles per repeat, so `patternScale` is four tiles'
  // width. Each tile is a hair lighter or darker than its neighbours, as
  // glazed tiles from one batch are, and the joints are thin and slightly
  // darker than the tile.
  tiles: {
    size: 1024,
    draw(ctx, size, rand) {
      const count = 4;
      const cell = size / count;
      const glaze = fbm(rand, 3, 6);
      const tones = Array.from({ length: count * count }, () => 0.955 + rand() * 0.04);
      paintPixels(ctx, size, (u, v) => {
        const i = Math.min(count - 1, Math.floor(u * count));
        const j = Math.min(count - 1, Math.floor(v * count));
        return tones[j * count + i] + (glaze(u, v) - 0.5) * 0.025;
      });
      ctx.fillStyle = grey(0.8, 0.9);
      const joint = Math.max(1.5, size / 400);
      for (let k = 0; k < count; k++) {
        ctx.fillRect(k * cell - joint / 2, 0, joint, size);
        ctx.fillRect(0, k * cell - joint / 2, size, joint);
      }
      // The joint at the seam, drawn on both edges so the texture tiles.
      ctx.fillRect(size - joint / 2, 0, joint / 2, size);
      ctx.fillRect(0, size - joint / 2, size, joint / 2);
    },
  },
};

function toTexture(canvas: HTMLCanvasElement, maxAnisotropy: number) {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = Math.min(8, maxAnisotropy);
  return texture;
}

export class TextureLibrary {
  private readonly cache = new Map<SurfacePattern, Texture>();
  /** Tilings already made, by pattern and repeat. */
  private readonly tilings = new Map<string, Texture>();
  private readonly owned: Texture[] = [];

  constructor(private readonly maxAnisotropy: number) {}

  /**
   * A texture tiled at `scale` metres per repeat (geometry UVs are in metres).
   *
   * Tilings are shared: a tiling is only a repeat setting over a drawing
   * that is already cached, and nothing mutates one after it is made. That
   * matters once materials can be edited — a colour dragged through a
   * hundred values asks for the same tiling a hundred times, and must not
   * leave a hundred textures behind.
   */
  get(pattern: SurfacePattern, scale = 1): Texture | null {
    if (pattern === "none") return null;
    const key = `${pattern}@${scale}`;
    const existing = this.tilings.get(key);
    if (existing) return existing;

    let base = this.cache.get(pattern);
    if (!base) {
      const spec = patterns[pattern];
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = spec.size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      spec.draw(ctx, spec.size, mulberry32(hash(pattern)));
      base = toTexture(canvas, this.maxAnisotropy);
      this.cache.set(pattern, base);
      this.owned.push(base);
    }
    const tiled = base.clone();
    tiled.repeat.set(1 / scale, 1 / scale);
    this.tilings.set(key, tiled);
    this.owned.push(tiled);
    return tiled;
  }

  /** Draw a one-off image, e.g. an artwork. */
  image(key: string, width: number, height: number, draw: Draw): Texture | null {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    draw(ctx, width, mulberry32(hash(key)));
    const texture = toTexture(canvas, this.maxAnisotropy);
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
    this.owned.push(texture);
    return texture;
  }

  dispose() {
    this.owned.forEach((t) => t.dispose());
    this.owned.length = 0;
    this.cache.clear();
    this.tilings.clear();
  }
}

function hash(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}
