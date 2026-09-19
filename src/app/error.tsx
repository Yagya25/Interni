"use client";

import { useEffect } from "react";
import { Button, ButtonLink } from "@/components/Button";
import { PageShell } from "@/components/PageShell";
import { StatusState } from "@/components/StatusState";
import { routes } from "@/config/site";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageShell>
      <StatusState
        status="error"
        title="Something broke while loading this page."
        description={<p>Trying again may fix it. If it doesn’t, the start page still works.</p>}
        action={
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <Button onClick={() => retry()} arrow>
              Try again
            </Button>
            <ButtonLink href={routes.home} variant="text">
              Back to the start
            </ButtonLink>
          </div>
        }
      />
    </PageShell>
  );
}
