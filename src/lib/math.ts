export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const invLerp = (a: number, b: number, value: number) => (a === b ? 0 : (value - a) / (b - a));

/** Maps `value` from [inMin, inMax] to [0, 1], clamped. */
export const range = (inMin: number, inMax: number, value: number) =>
  clamp(invLerp(inMin, inMax, value));

export const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = range(edge0, edge1, value);
  return t * t * (3 - 2 * t);
};

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export const degToRad = (deg: number) => (deg * Math.PI) / 180;
