/**
 * What may be sent to the worker. The file's own bytes decide what it is;
 * its name never does, and a declared type may only agree with them. The
 * worker's intake still has the last word on decoding and on pixel size.
 */

export type ImageKind = { type: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" };

export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return { type: "image/jpeg", ext: "jpg" };
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { type: "image/png", ext: "png" };
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { type: "image/webp", ext: "webp" };
  return null;
}

export type Validation = { ok: true; kind: ImageKind } | { ok: false; status: number; code: string };

export function validateUpload(bytes: Uint8Array, declaredType: string, maxBytes: number): Validation {
  if (bytes.length === 0) return { ok: false, status: 400, code: "not-decodable" };
  if (bytes.length > maxBytes) return { ok: false, status: 413, code: "too-large" };
  const kind = sniffImage(bytes);
  if (!kind) return { ok: false, status: 415, code: "wrong-type" };
  const declared = declaredType.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== kind.type) {
    return { ok: false, status: 415, code: "wrong-type" };
  }
  return { ok: true, kind };
}
