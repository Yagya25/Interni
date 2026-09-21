"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { applyOperations } from "@/scene/model/operations";
import type { Id, Material, Scene } from "@/scene/model/types";
import type { CommandInterpreter, Interpretation, ReplacementRequest, SceneCommand } from "../ai/interpreter";
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
   * selection before it can mean anything.
   */
  command: { pending: boolean; note: string | null; tone: "plain" | "select" };
  /**
   * A request that was understood but that this build cannot carry out,
   * shown with what was asked so it is plain the words were read.
   */
  limitation: { command: string; message: string; request: ReplacementRequest } | null;
  /** What the last applied proposal did, shown briefly after Apply. */
  receipt: { summary: string; changes: number } | null;
}

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
      command: { pending: false, note: null, tone: "plain" },
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
    this.set({ doc, ...this.dropped(doc) });
  }

  /** End a gesture. The next edit begins a new history entry. */
  seal() {
    const doc = seal(this.state.doc);
    if (doc !== this.state.doc) this.set({ doc });
  }

  undo() {
    const doc = undo(this.state.doc);
    if (doc === this.state.doc) return;
    this.set({ doc, ...this.dropped(doc) });
  }

  redo() {
    const doc = redo(this.state.doc);
    if (doc === this.state.doc) return;
    this.set({ doc, ...this.dropped(doc) });
  }

  /** Selection survives undo only while its object still exists. */
  private dropped(doc: WorkspaceDocument) {
    const gone = this.state.selection && !doc.scene.objects.some((o) => o.id === this.state.selection);
    return gone ? { selection: null } : null;
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
      command: { pending: false, note: null, tone: "plain" },
      limitation: null,
      receipt: null,
    });
  }

  togglePreview(changeId: string) {
    const previewing = new Set(this.state.previewing);
    if (!previewing.delete(changeId)) previewing.add(changeId);
    this.set({ previewing });
  }

  /** Accept the previewed changes, as one undoable edit each. */
  acceptProposal() {
    const { proposal, previewing } = this.state;
    if (!proposal) return;
    let doc = this.state.doc;
    let applied = 0;
    for (const change of proposal.changes) {
      if (!previewing.has(change.id)) continue;
      const next = seal(commit(doc, change.operations, `${change.target} — ${change.detail}`));
      if (next !== doc) applied += 1;
      doc = next;
    }
    this.set({
      doc,
      proposal: null,
      previewing: new Set(),
      receipt: applied > 0 ? { summary: proposal.summary, changes: applied } : null,
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
    this.set({ command: { pending: true, note: null, tone: "plain" }, limitation: null, receipt: null });
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
          command: { pending: false, note: null, tone: "plain" },
          limitation: { command: result.command, message: result.message, request: result.request },
        });
        return true;
      }
      this.note(result.message, result.outcome === "clarify" ? "select" : "plain");
      return false;
    } catch (error) {
      if (signal.aborted) return false;
      this.note(error instanceof Error ? error.message : "The command could not be read.");
      return false;
    }
  }

  private note(note: string, tone: "plain" | "select" = "plain") {
    this.set({ command: { pending: false, note, tone } });
  }

  clearNote() {
    if (!this.state.command.note) return;
    this.set({ command: { pending: false, note: null, tone: "plain" } });
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
