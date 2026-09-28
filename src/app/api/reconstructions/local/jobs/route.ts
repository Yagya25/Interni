import { enqueueUpload } from "@/features/workspace/reconstruction/jobs/api";

// Starts work on this machine; never prerendered.
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return enqueueUpload(request);
}
