import { listRuns } from "@/features/workspace/reconstruction/localRuns";

// Reads the local runs directory on every request; never prerendered.
export const dynamic = "force-dynamic";

export function GET() {
  return listRuns();
}
