import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";
import { routes } from "@/config/site";
import { Entry } from "@/features/workspace/entry/Entry";

export const metadata: Metadata = {
  title: "Your space",
  description:
    "Bring a photograph of a room, or open the demonstration space and take it apart.",
  alternates: { canonical: routes.workspace },
  robots: { index: false, follow: true },
};

export default function WorkspaceEntryPage() {
  return (
    <PageShell>
      <Entry />
    </PageShell>
  );
}
