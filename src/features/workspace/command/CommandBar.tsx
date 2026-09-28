"use client";

import { useEffect, useRef, useState } from "react";
import { SendIcon } from "../icons";
import { useSelectedObject, useStore, useWorkspace, type NoteKind } from "../state/store";
import styles from "./CommandBar.module.css";

/** What each kind of answer is called where it is shown. */
const KIND_LABEL: Record<NoteKind, string> = {
  ambiguous: "Ambiguous",
  "needs-subject": "Which piece?",
  "needs-destination": "Where to?",
  unsupported: "Unsupported",
  unavailable: "Not available yet",
  "no-change": "No change",
  "not-understood": "Not understood",
  answer: "Answer",
  agent: "Design agent",
};

/**
 * The command surface.
 *
 * Not a chat window: there is no transcript, no reply and no persona. One
 * line, about the room, with whatever is selected carried along as its
 * subject. It sends to the interpreter, and when there is no interpreter
 * it says so plainly rather than inventing an answer.
 *
 * Every answer says what kind it is. When a name fits several pieces, each
 * is offered by name and where it stands; choosing one selects it and asks
 * again, so the same words now mean that piece.
 */
export function CommandBar() {
  const store = useStore();
  const selected = useSelectedObject();
  const pending = useWorkspace((s) => s.command.pending);
  const note = useWorkspace((s) => s.command.note);
  const tone = useWorkspace((s) => s.command.tone);
  const kind = useWorkspace((s) => s.command.kind);
  const asked = useWorkspace((s) => s.command.text);
  const options = useWorkspace((s) => s.command.options);
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const runRef = useRef<AbortController | null>(null);

  const { available, unavailableReason } = store.interpreter;
  const ready = text.trim().length > 0 && !pending;

  useEffect(() => () => runRef.current?.abort(), []);

  // Grow with the text, up to a few lines, then scroll.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 132)}px`;
  }, [text]);

  const send = (words: string) => {
    runRef.current?.abort();
    const controller = new AbortController();
    runRef.current = controller;
    // The words stay in the field unless they produced something, so an
    // unread phrasing can be corrected rather than retyped.
    void store.run(words, controller.signal).then((consumed) => {
      if (consumed && !controller.signal.aborted) setText("");
    });
  };

  const submit = () => {
    if (ready) send(text.trim());
  };

  /** One of the pieces an ambiguous name could mean: select it, and ask the same thing again. */
  const choose = (id: string) => {
    if (!asked || pending) return;
    store.select(id);
    send(asked);
  };

  return (
    <form
      className={styles.bar}
      data-region="command"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={styles.frame} data-pending={pending || undefined}>
        {selected && (
          <span className={styles.subject}>
            <span className={styles.subjectLabel}>About</span>
            {selected.label}
          </span>
        )}
        <textarea
          ref={areaRef}
          className={styles.input}
          rows={1}
          value={text}
          placeholder={
            selected ? `Ask about ${selected.label.toLowerCase()}…` : "Ask anything about your space…"
          }
          aria-label="Ask about your space"
          disabled={pending}
          onChange={(event) => {
            setText(event.target.value);
            store.clearNote();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            submit();
          }}
        />
        <button
          type="submit"
          className={styles.send}
          disabled={!ready}
          title={available ? "Send" : unavailableReason}
        >
          <SendIcon />
          <span className="visually-hidden">Send command</span>
        </button>
      </div>

      {/* Said before it is tried, not only after. */}
      {!available && text.trim().length > 0 && !note && (
        <p className={styles.notice}>{unavailableReason}</p>
      )}
      {pending && (
        <p className={styles.notice} role="status">
          Processing…
        </p>
      )}
      {note && (
        <div className={styles.answer} data-tone={tone} role="status">
          <p className={styles.notice} data-tone={tone}>
            {kind && <span className={styles.kind}>{KIND_LABEL[kind]}</span>}
            {note}
          </p>
          {options.length > 0 && (
            <ul className={styles.options} aria-label="Which one">
              {options.map((option) => (
                <li key={option.id}>
                  <button type="button" className={styles.option} onClick={() => choose(option.id)}>
                    <span className={styles.optionLabel}>{option.label}</span>
                    {option.description && <span className={styles.optionWhere}>{option.description}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
