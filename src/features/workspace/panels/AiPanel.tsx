"use client";

import { useSelectedObject, useStore } from "../state/store";
import { Note, Panel, Section } from "./Panel";
import styles from "./ai.module.css";

/**
 * What is answering, and what it can answer.
 *
 * The panel reads the interpreter's own description rather than carrying
 * copy of its own, so it cannot drift from what is connected. A rule-based
 * reader says it is one and lists requests it genuinely handles; a model
 * would say something else. Nothing here implies more than is there.
 */

const PIPELINE = [
  { name: "Command", detail: "What you asked, and what was selected when you asked it." },
  { name: "Interpretation", detail: "Read as an intent, then as changes — or a question back, or an honest no." },
  { name: "Operations", detail: "Moves, restyles, relights — the same edits a hand makes." },
  { name: "Preview", detail: "Laid over the room, kept or dropped one at a time." },
  { name: "Applied", detail: "In the history, and reversible." },
] as const;

export function AiPanel() {
  const store = useStore();
  const selected = useSelectedObject();
  const { name, kind, note, examples, available, unavailableReason } = store.interpreter;

  return (
    <Panel
      id="panel-ai"
      title="Ask"
      summary="Describe a change to the room and it becomes an edit you can see before you keep it."
      onClose={() => store.setTool(null)}
    >
      <Section title="Interpreter">
        <p className={styles.status} data-available={available || undefined}>
          <span className={styles.dot} aria-hidden="true" />
          {name}
          <span className={styles.kind}>{kind === "model" ? "Model" : "Rule-based"}</span>
        </p>
        <Note>{available ? note : (unavailableReason ?? note)}</Note>
      </Section>

      {examples.length > 0 && (
        <Section title="Phrasings it reads">
          <ul className={styles.examples}>
            {examples.map((example) => (
              <li key={example}>{example}</li>
            ))}
          </ul>
          <p className={styles.aside}>
            Anything else is declined rather than guessed at.
          </p>
        </Section>
      )}

      <Section title="The path a sentence takes">
        <ol className={styles.pipeline}>
          {PIPELINE.map((stage) => (
            <li key={stage.name} className={styles.stage} data-built>
              <span className={styles.stageName}>{stage.name}</span>
              <span className={styles.stageDetail}>{stage.detail}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Context">
        <Note>
          {selected
            ? `A command written now arrives with ${selected.label.toLowerCase()} as its subject, so “this” means that piece.`
            : "Nothing is selected, so “this” has nothing to point at. Commands about the room as a whole still work."}
        </Note>
      </Section>
    </Panel>
  );
}
