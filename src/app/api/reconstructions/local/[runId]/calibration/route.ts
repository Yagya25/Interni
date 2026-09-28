import { saveCalibration } from "@/features/workspace/reconstruction/calibrationFile";

export const dynamic = "force-dynamic";

/** Replace the run's calibration references (the previous file is kept). An empty list removes it. */
export async function PUT(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: "invalid-calibration", message: "The body must be JSON." }, { status: 400 });
  }
  return saveCalibration(runId, body);
}
