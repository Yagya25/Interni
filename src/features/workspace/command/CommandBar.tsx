"use client";

import { useEffect, useRef, useState } from "react";
import { SendIcon } from "../icons";
import { useSelectedObject, useStore, useWorkspace } from "../state/store";
import styles from "./CommandBar.module.css";

/**
 * The command surface.
 *
 * Not a chat window: there is no transcript, no reply and no persona. One
 * line, about the room, with whatever is selected carried along as its
 * subject. It sends to the interpreter, and when there is no interpreter
 * it says so plainly rather than inventing an answer.
 */
export function CommandBar() {
  const store = useStore();
  const selected = useSelectedObject();
  const pending = useWorkspace((s) => s.command.pending);
  const note = useWorkspace((s) => s.command.note);
  const tone = useWorkspace((s) => s.command.tone);
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

  const submit = () => {
    if (!ready) return;
    runRef.current?.abort();
    const controller = new AbortController();
    runRef.current = controller;
    // The words stay in the field unless they produced something, so an
    // unread phrasing can be corrected rather than retyped.
    void store.run(text.trim(), controller.signal).then((consumed) => {
      if (consumed && !controller.signal.aborted) setText("");
    });
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
      {note && (
        <p className={styles.notice} data-tone={tone} role="status">
          {note}
        </p>
      )}
    </form>
  );
}
