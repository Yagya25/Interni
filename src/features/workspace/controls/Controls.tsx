"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import type { Material } from "@/scene/model/types";
import styles from "./controls.module.css";

/**
 * The workspace's instruments.
 *
 * Every one of them reports two things: `onChange` while the value is
 * moving, and `onSettle` when the hand comes off. The store applies the
 * first straight away and seals the history on the second, so a drag across
 * a field is one thing to undo rather than forty.
 */

interface FieldProps {
  label: string;
  children: ReactNode;
  /** Secondary reading, e.g. the same value in another unit. */
  note?: string;
}

export function Field({ label, children, note }: FieldProps) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldControl}>{children}</div>
      {note && <span className={styles.fieldNote}>{note}</span>}
    </div>
  );
}

/** A read-only pair: what it is, and what it says. */
export function Reading({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.reading}>
      <dt className={styles.readingLabel}>{label}</dt>
      <dd className={styles.readingValue}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** One arrow press, and the smallest change a drag can make. */
  step: number;
  unit?: string;
  decimals?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onSettle: () => void;
}

/** How far the pointer travels before a press becomes a drag. */
const SLOP = 3;

/**
 * A measurement you can drag, type or step.
 *
 * Dragging sideways is the fast way; a press that goes nowhere puts the
 * caret in the field so a number can be typed exactly. Both end in the
 * same place, which is what makes it feel like an instrument rather than
 * a form.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit,
  decimals = 2,
  disabled,
  onChange,
  onSettle,
}: NumberFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  const [typing, setTyping] = useState<string | null>(null);

  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const shown = typing ?? value.toFixed(decimals);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || typing !== null || event.button !== 0) return;
    drag.current = { x: event.clientX, from: value, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const travelled = event.clientX - state.x;
    if (!state.moved && Math.abs(travelled) < SLOP) return;
    state.moved = true;
    // A whole step every four pixels, and a tenth of one with Shift held.
    const grain = event.shiftKey ? step / 10 : step;
    const next = clamp(state.from + Math.round(travelled / 4) * grain);
    if (next !== value) onChange(round(next, decimals));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.moved) onSettle();
    else inputRef.current?.focus();
  };

  const commitTyped = () => {
    if (typing === null) return;
    const parsed = Number.parseFloat(typing.replace(",", "."));
    setTyping(null);
    if (Number.isFinite(parsed)) {
      const next = round(clamp(parsed), decimals);
      if (next !== value) onChange(next);
    }
    onSettle();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitTyped();
      inputRef.current?.blur();
      return;
    }
    if (event.key === "Escape") {
      setTyping(null);
      inputRef.current?.blur();
      return;
    }
    const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const grain = event.shiftKey ? step * 10 : step;
    onChange(round(clamp(value + direction * grain), decimals));
    onSettle();
  };

  return (
    <div
      className={styles.number}
      data-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <input
        ref={inputRef}
        className={styles.numberInput}
        value={shown}
        inputMode="decimal"
        aria-label={label}
        disabled={disabled}
        onChange={(event) => setTyping(event.target.value)}
        onFocus={() => setTyping(value.toFixed(decimals))}
        onBlur={commitTyped}
        onKeyDown={onKeyDown}
      />
      {unit && <span className={styles.numberUnit}>{unit}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface RangeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onSettle: () => void;
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
  onSettle,
}: RangeFieldProps) {
  return (
    <input
      type="range"
      className={styles.range}
      aria-label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      onPointerUp={onSettle}
      onKeyUp={onSettle}
      onBlur={onSettle}
    />
  );
}

// ---------------------------------------------------------------------------

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

/** Real radios underneath, so arrow keys and screen readers work for free. */
export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  const name = useId();
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className={styles.segment} data-on={option.value === value || undefined}>
          <input
            type="radio"
            name={name}
            className={styles.segmentInput}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** A material, as a painter's chip: its colour, its name, its finish. */
export function Swatch({ material, size = "m" }: { material: Material; size?: "s" | "m" }) {
  return (
    <span
      className={styles.swatch}
      data-size={size}
      style={{ background: material.color }}
      aria-hidden="true"
    />
  );
}

interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSettle: () => void;
}

export function ColorField({ label, value, onChange, onSettle }: ColorFieldProps) {
  return (
    <label className={styles.color}>
      <input
        type="color"
        className={styles.colorInput}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onSettle}
      />
      <span className={styles.colorChip} style={{ background: value }} aria-hidden="true" />
      <span className={styles.colorValue}>{value.toUpperCase()}</span>
    </label>
  );
}

const round = (value: number, decimals: number) => Number(value.toFixed(decimals));
