import type { CalibrationReference } from "@/scene/compile/calibration";

/** Save a run's calibration references on this machine. The server keeps the file they replace. */
export async function saveCalibration(
  runId: string,
  references: readonly CalibrationReference[],
): Promise<{ ok: true; references: readonly CalibrationReference[] } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetch(`/api/reconstructions/local/${encodeURIComponent(runId)}/calibration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, references }),
    });
  } catch {
    return { ok: false, reason: "The server couldn't be reached, so nothing was saved." };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, reason: body?.message ?? `The calibration wasn't saved (HTTP ${response.status}).` };
  return { ok: true, references: body.references };
}
