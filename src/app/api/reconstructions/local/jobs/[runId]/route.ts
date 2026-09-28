import { jobStatus } from "@/features/workspace/reconstruction/jobs/api";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return jobStatus(runId);
}
