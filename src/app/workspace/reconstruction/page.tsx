import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";
import { routes } from "@/config/site";
import { ReconstructionIndex } from "@/features/workspace/reconstruction/ReconstructionIndex";

export const metadata: Metadata = {
  title: "Local reconstructions",
  description: "Rooms reconstructed from photographs by the reconstruction worker on this machine.",
  alternates: { canonical: `${routes.workspace}/reconstruction` },
  robots: { index: false, follow: false },
};

export default function ReconstructionIndexPage() {
  return (
    <PageShell>
      <ReconstructionIndex />
    </PageShell>
  );
}
