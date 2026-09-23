"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { applyOperations } from "@/scene/model/operations";
import type { Id, Material, Scene } from "@/scene/model/types";
import type { ClarifyOption, CommandInterpreter, Interpretation, ReplacementRequest, SceneCommand } from "../ai/interpreter";
import type { Intent } from "./edits";
import {
  canRedo,
  canUndo,
  commit,
  createDocument,
  redo,
  seal,
  undo,
  type WorkspaceDocument,
} from "./document";

export type ToolId = "ai" | "objects" | "materials" | "lighting" | "camera";

export interface WorkspaceState {
  doc: WorkspaceDocument;
  selection: Id | null;
  /** The open tool panel, or null when the room has the floor to itself. */
  tool: ToolId | null;
  /**
   * What the renderer draws: the document's scene with any accepted part of
   * a proposal laid over it. Derived once per change, never in a render.
   */
  scene: Scene;
  proposal: Interpretation | null;
  /** Which of a proposal's changes are currently in the preview. */
  previewing: ReadonlySet<string>;
  /**
   * What the command bar has to say. `note` is an honest answer that is not
   * a failure — a phrasing that isn't understood, or a request that needs a
   * selection before it can mean anything. `kind` says which, and `options`
   * are the pieces an ambiguous name could mean, for the person to pick.
   */
  command: CommandNote;
  /**
   * A request that was understood but that this build cannot carry out,
   * shown with what was asked so it is plain the words were read.
   */
  limitation: { command: string; message: string; request: ReplacementRequest } | null;
  /** What the last applied proposal did, shown briefly after Apply: one step in the history. */
  receipt: { title: string; summary: string; changes: number } | null;
}

/** How the interpreter answered, when it didn't answer with changes. */
export type NoteKind = "ambiguous" | "needs-subject" | "needs-destination" | "unsupported" | "unavailable" | "no-change" | "not-understood";

export interface CommandNote {
  pending: boolean;
  note: string | null;
  tone: "plain" | "select";
  kind: NoteKind | null;
  /** The words the note answers, so a choice among `options` can ask again. */
  text: string | null;
  options: readonly ClarifyOption[];
}

const IDLE: CommandNote = { pending: false, note: null, tone: "plain", kind: null, text: null, options: [] };

/**
 * The workspace's single source of truth.
 *
 * Every change to the room is an operation applied to the document; the
 * renderer is told about the resulting scene and nothing else. No component
 * keeps its own copy of the room, and no component touches a mesh.
 *
 * An instance per mounted workspace, reached through React context, so
 * state does not outlive the page or leak between two of them.
 */
export class WorkspaceStore {
  private state: WorkspaceState;
  private readonly listeners = new Set<() => void>();

  constructor(
    scene: Scene,
    name: string,
    readonly interpreter: CommandInterpreter,
    /** Finishes this space can be given. A reconstruction brings its own. */
    readonly palette: readonly Material[],
  ) {
    this.state = {
      doc: createDocument(scene, name),
      selection: null,
      tool: null,
      scene,
      proposal: null,
      previewing: new Set(),
      command: IDLE,
      limitation: null,
      receipt: null,
    };
  }

  getState = (): WorkspaceState => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // -------------------------------------------------------------------------
  // Editing

  /**
   * Apply an edit. An intent's merge key marks one continuous gesture, so a
   * drag or a slider leaves a single entry in the history, not one per frame.
   */
  apply(intent: Intent) {
    const doc = commit(this.state.doc, intent.operations, intent.label, intent.mergeKey);
    if (doc === this.state.doc) return;
    this.set({ doc, ...this.moved(doc) });
  }

  /** End a gesture. The next edit begins a new history entry. */
  seal() {
    const doc = seal(this.state.doc);
    if (doc !== this.state.doc) this.set({ doc });
  }

  undo() {
    const doc = undo(this.state.doc);
    if (doc === this.state.doc) return;
    this.set({ doc, ...this.moved(doc) });
  }

  redo() {
    const doc = redo(this.state.doc);
    if (doc === this.state.doc) return;
    this.set({ doc, ...this.moved(doc) });
  }

  /** Selection survives undo only while its object still exists. */
  private dropped(doc: WorkspaceDocument) {
    const gone = this.state.selection && !doc.scene.objects.some((o) => o.id === this.state.selection);
    return gone ? { selection: null } : null;
  }

  /**
   * After any step through the history other than applying a proposal:
   * the selection, as `dropped` says, and the receipt of the last command,
   * which no longer describes the last step — its Undo would otherwise take
   * back a different one.
   */
  private moved(doc: WorkspaceDocument) {
    return { ...this.dropped(doc), ...(this.state.receipt && { receipt: null }) };
  }

  rename(name: string) {
    this.set({ doc: { ...this.state.doc, name } });
  }

  // -------------------------------------------------------------------------
  // Focus

  select(id: Id | null) {
    if (this.state.selection === id) return;
    // A new subject ends whatever gesture was running on the old one.
    this.set({ selection: id, doc: seal(this.state.doc) });
  }

  setTool(tool: ToolId | null) {
    this.set({ tool: this.state.tool === tool ? null : tool });
  }

  // -------------------------------------------------------------------------
  // Proposals
  //
  // A proposal is a set of operations that have not been applied yet. The
  // ones being previewed are laid over the document for the renderer only;
  // the document itself is untouched until they are accepted.

  propose(proposal: Interpretation) {
    this.set({
      proposal,
      previewing: new Set(proposal.changes.map((c) => c.id)),
      command: IDLE,
      limitation: null,
      receipt: null,
    });
  }

  togglePreview(changeId: string) {
    const previewing = new Set(this.state.previewing);
    if (!previewing.delete(changeId)) previewing.add(changeId);
    this.set({ previewing });
  }

  /**
   * Accept the previewed changes as one edit: a command is one thing the
   * person did, so one undo takes all of it back — the walls, the bulbs and
   * the hour of "make the room warmer" together.
   */
  acceptProposal() {
    const { proposal, previewing } = this.state;
    if (!proposal) return;
    const kept = proposal.changes.filter((change) => previewing.has(change.id));
    const doc = seal(commit(seal(this.state.doc), kept.flatMap((change) => change.operations), proposal.title));
    this.set({
      doc,
      proposal: null,
      previewing: new Set(),
      receipt: doc !== this.state.doc ? { title: proposal.title, summary: proposal.summary, changes: kept.length } : null,
      // A command that took the selected piece away takes the selection with it.
      ...this.dropped(doc),
    });
  }

  discardProposal() {
    if (!this.state.proposal && !this.state.limitation) return;
    this.set({ proposal: null, previewing: new Set(), limitation: null });
  }

  clearReceipt() {
    if (this.state.receipt) this.set({ receipt: null });
  }


  /**
   * Send a command to the interpreter.
   *
   * Four answers are possible and all of them are honest: a set of changes
   * to preview; a request understood but not yet possible; a question back,
   * when "this" points at nothing or a name fits several pieces; or words
   * that could not be read as an edit. Returns true when the words were
   * consumed, so the command bar knows whether to clear.
   */
  async run(text: string, signal: AbortSignal): Promise<boolean> {
    if (!this.interpreter.available) {
      this.note(this.interpreter.unavailableReason ?? "No interpreter is connected.");
      return false;
    }
    const command: SceneCommand = {
      text,
      subjectId: this.state.selection,
      scene: this.state.doc.scene,
    };
    this.set({ command: { ...IDLE, pending: true, text }, limitation: null, receipt: null });
    try {
      const result = await this.interpreter.interpret(command, signal);
      if (signal.aborted) return false;
      if (result.outcome === "changes") {
        this.propose(result.interpretation);
        return true;
      }
      if (result.outcome === "unavailable" && result.request) {
        this.set({
          proposal: null,
          previewing: new Set(),
          command: IDLE,
          limitation: { command: result.command, message: result.message, request: result.request },
        });
        return true;
      }
      if (result.outcome === "clarify") {
        const { clarification } = result;
        const kind: NoteKind = clarification.reason === "ambiguous" ? "ambiguous" : clarification.reason === "no-reference" ? "needs-destination" : "needs-subject";
        this.note(result.message, "select", kind, text, clarification.reason === "ambiguous" ? clarification.options : []);
        return false;
      }
      const kind: NoteKind = result.outcome === "unavailable" ? (result.already ? "no-change" : "unavailable") : result.intent ? "unsupported" : "not-understood";
      this.note(result.message, "plain", kind, text);
      return false;
    } catch (error) {
      if (signal.aborted) return false;
      this.note(error instanceof Error ? error.message : "The command could not be read.", "plain", "unsupported", text);
      return false;
    }
  }

  private note(note: string, tone: "plain" | "select" = "plain", kind: NoteKind | null = null, text: string | null = null, options: readonly ClarifyOption[] = []) {
    this.set({ command: { pending: false, note, tone, kind, text, options } });
  }

  clearNote() {
    if (!this.state.command.note) return;
    this.set({ command: IDLE });
  }

  // -------------------------------------------------------------------------

  private set(change: Partial<WorkspaceState> | null) {
    if (!change) return;
    const next = { ...this.state, ...change };
    next.scene = renderedScene(next);
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}

function renderedScene(state: WorkspaceState): Scene {
  const { doc, proposal, previewing } = state;
  if (!proposal || previewing.size === 0) return doc.scene;
  const operations = proposal.changes
    .filter((change) => previewing.has(change.id))
    .flatMap((change) => change.operations);
  return applyOperations(doc.scene, operations);
}

// ---------------------------------------------------------------------------
// React

const WorkspaceContext = createContext<WorkspaceStore | null>(null);
export const WorkspaceProvider = WorkspaceContext.Provider;

export function useStore(): WorkspaceStore {
  const store = useContext(WorkspaceContext);
  if (!store) throw new Error("useStore must be used inside a WorkspaceProvider");
  return store;
}

/**
 * Read one value from the store. Selectors must return something stable for
 * an unchanged state — a primitive, or a reference the state already holds —
 * because it is read on every render.
 */
export function useWorkspace<T>(selector: (state: WorkspaceState) => T): T {
  const store = useStore();
  const read = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, read, read);
}

export const useCanUndo = () => useWorkspace((s) => canUndo(s.doc));
export const useCanRedo = () => useWorkspace((s) => canRedo(s.doc));
export const useSelectedObject = () =>
  useWorkspace((s) => s.scene.objects.find((o) => o.id === s.selection) ?? null);
