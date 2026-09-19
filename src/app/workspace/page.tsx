import type { Metadata } from "next";
import { ButtonLink } from "@/components/Button";
import { PageShell } from "@/components/PageShell";
import { StatusState } from "@/components/StatusState";
import { anchors, routes } from "@/config/site";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Where a photograph of your room becomes an editable model. Not open yet.",
  alternates: { canonical: routes.workspace },
  robots: { index: false, follow: true },
};

const steps = [
  ["01", "Photograph", "Bring one photo of a room, taken from a corner at eye height."],
  ["02", "Model", "Walls, openings, objects, materials and light, reconstructed as one scene."],
  ["03", "Redesign", "Move, replace and restyle, or ask for a direction and compare variants."],
] as const;

export default function WorkspacePage() {
  return (
    <PageShell>
      <div className={styles.layout}>
        <StatusState
          status="empty"
          kicker="Not open yet"
          title="The workspace isn’t open yet."
          description={
            <p>
              This is where you will bring a photograph of your room and get back a model you can edit.
              Reconstruction isn’t connected in this build, so there is nothing to upload to yet.
            </p>
          }
          action={
            <div className={styles.actions}>
              <ButtonLink href={`${routes.home}#${anchors.sequence}`} arrow>
                See the walkthrough
              </ButtonLink>
              <ButtonLink href={routes.home} variant="text">
                Back to the start
              </ButtonLink>
            </div>
          }
        />

        <ol className={styles.steps} aria-label="What will happen here">
          {steps.map(([index, name, text]) => (
            <li key={index} className={styles.step}>
              <span className={styles.stepIndex}>{index}</span>
              <span className={styles.stepName}>{name}</span>
              <span className={styles.stepText}>{text}</span>
            </li>
          ))}
        </ol>
      </div>
    </PageShell>
  );
}
