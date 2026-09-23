import { readRunFile } from "@/features/workspace/reconstruction/localRuns";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ runId: string; file: string }> }) {
  const { runId, file } = await context.params;
  return readRunFile(runId, file);
}
