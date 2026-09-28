import { createHash, randomBytes } from "node:crypto";

/**
 * `<UTC stamp>-<sha256 of the bytes, 8 hex>-<8 random hex>`: the worker's
 * own `<stamp>-<digest>` naming, plus randomness so two uploads of the same
 * photograph in the same second still get separate runs.
 */
export function newRunId(bytes: Uint8Array, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return `${stamp}-${digest}-${randomBytes(4).toString("hex")}`;
}
