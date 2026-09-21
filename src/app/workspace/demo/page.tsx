import type { Metadata } from "next";
import { routes } from "@/config/site";
import { DemoWorkspace } from "@/features/workspace/DemoWorkspace";

export const metadata: Metadata = {
  title: "Demo space",
  description:
    "The demonstration living room, open as an editable model: objects, materials, light and history.",
  alternates: { canonical: `${routes.workspace}/demo` },
  robots: { index: false, follow: true },
};

export default function DemoWorkspacePage() {
  return <DemoWorkspace />;
}
