import type { Metadata } from "next";
import { ReconstructionWorkspace } from "@/features/workspace/reconstruction/ReconstructionWorkspace";

export const metadata: Metadata = {
  title: "Reconstructed room",
  description: "A room reconstructed from a photograph, open in the workspace.",
  robots: { index: false, follow: false },
};

export default async function ReconstructionPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <ReconstructionWorkspace runId={runId} />;
}
