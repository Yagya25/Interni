import type { Metadata } from "next";
import { ButtonLink } from "@/components/Button";
import { PageShell } from "@/components/PageShell";
import { StatusState } from "@/components/StatusState";
import { routes } from "@/config/site";

export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <PageShell>
      <StatusState
        status="empty"
        kicker="Not found"
        title="There’s no room at this address."
        description={<p>The page you asked for doesn’t exist, or it has moved.</p>}
        action={
          <ButtonLink href={routes.home} arrow>
            Back to the start
          </ButtonLink>
        }
      />
    </PageShell>
  );
}
