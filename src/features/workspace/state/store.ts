"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { applyOperations } from "@/scene/model/operations";
import type { Id, Material, Scene } from "@/scene/model/types";
import type { ClarifyOption, CommandInterpreter, Interpretation, ReplacementRequest, SceneCommand } from "../ai/interpreter";
import {
  applied as appliedTo,
  DESIGN_MESSAGES,
  previewing as previewingIn,
  proposalAt,
  proposalOf,
  readDesigns,
  type DesignSession,
} from "../design";
import { readDesignRequest, type DesignRequest } from "../design/read";
import { fromIntent } from "../design/session";
import type { SceneEvidence } from "@/scene/compile/evidence";
import { roomBrief } from "../agent/brief";
import { AGENT_MESSAGES } from "../agent/messages";
import { readThresholdQuestion, resolveQuestion } from "../agent/question";
import { preRoute } from "../agent/route";
import type { DesignAgent, QuestionWire } from "../agent/types";
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
   * Design directions on screen, if any: a plan per card, none of which has
   * touched the document. One may be laid over the room to look at; applying
   * one hands its operations to the history like any other edit.
   */
  design: DesignSession | null;
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
export type NoteKind = "ambiguous" | "needs-subject" | "needs-destination" | "unsupported" | "unavailable" | "no-change" | "not-understood" | "answer" | "agent";

/** The design agent, when the server has one configured, with the evidence its brief and answers read. */
export interface AgentBinding {
  agent: DesignAgent;
  evidence: SceneEvidence | null;
}

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
      design: null,
      command: IDLE,
      limitation: null,
      receipt: null,
    };
  }

  /** The design agent, or null: without one, requests are routed exactly as before Phase 6. */
  private agent: AgentBinding | null = null;
  /** The last question the agent read, so choosing among pieces does not ask the model again. */
  private question: { text: string; wire: QuestionWire } | null = null;

  setAgent(binding: AgentBinding | null) {
    this.agent = binding;
    this.question = null;
  }

  get agentName(): string | null {
    return this.agent?.agent.name ?? null;
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
   * the selection, as `dropped` says; the receipt of the last command,
   * which no longer describes the last step — its Undo would otherwise take
   * back a different one; and any design laid over the room, which was laid
   * over the scene as it stood before the step.
   */
  private moved(doc: WorkspaceDocument) {
    return {
      ...this.dropped(doc),
      ...(this.state.receipt && { receipt: null }),
      ...(this.state.design?.previewId && { design: previewingIn(this.state.design, null) }),
    };
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
      // One thing is laid over the room at a time: a command's changes end
      // whatever design was being looked at, and the cards stay on screen.
      ...(this.state.design?.previewId && { design: previewingIn(this.state.design, null) }),
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

  // -------------------------------------------------------------------------
  // Designs
  //
  // A design proposal is a plan, not a change. Previewing lays its
  // operations over the document for the renderer only — exactly as a
  // command's proposal is previewed — so leaving the preview returns the
  // very Scene the room had, object for object. Applying one commits the
  // whole plan as a single entry in the history: one design, one undo.

  proposeDesigns(session: DesignSession) {
    this.set({ design: session, proposal: null, previewing: new Set(), command: IDLE, limitation: null, receipt: null });
  }

  previewDesign(id: string) {
    const { design } = this.state;
    if (!design || !proposalOf(design, id)) return;
    this.set({
      design: previewingIn(design, id),
      // A design and a command's changes cannot both be laid over the room.
      proposal: null,
      previewing: new Set(),
      limitation: null,
      receipt: null,
    });
  }

  exitDesignPreview() {
    const { design } = this.state;
    if (!design?.previewId) return;
    this.set({ design: previewingIn(design, null) });
  }

  /**
   * Apply a design: its operations, as one edit, through the same history
   * every other change goes through. Undo takes the whole design back.
   */
  applyDesign(id?: string) {
    const { design } = this.state;
    if (!design) return;
    const proposal = id ? proposalOf(design, id) : proposalAt(design, null);
    if (!proposal) return;
    const doc = seal(commit(seal(this.state.doc), proposal.operations, proposal.title));
    this.set({
      doc,
      design: appliedTo(design, proposal.id),
      proposal: null,
      previewing: new Set(),
      receipt:
        doc !== this.state.doc
          ? { title: proposal.title, summary: proposal.description, changes: proposal.preview.operationCount }
          : null,
      ...this.dropped(doc),
    });
  }

  /** Set the directions aside. The room is left exactly as it was. */
  dismissDesigns() {
    if (!this.state.design) return;
    this.set({ design: null });
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
    if (this.agent) return this.runWithAgent(this.agent, text, signal);
    // A design request and an edit command are different things and are kept
    // apart: "make the room warmer" is one edit to this room, "give me three
    // modern designs" is a set of directions for it. Only the second reaches
    // the design engine, and only when the words plainly ask for one.
    const request = readDesignRequest(text);
    if (request) return this.runDesign(text, request, signal);
    return this.runCommand(text, signal);
  }

  /** A Phase 3E command, through the interpreter. `notUnderstood` takes words it could not read at all. */
  private async runCommand(text: string, signal: AbortSignal, notUnderstood?: () => Promise<boolean>): Promise<boolean> {
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
      if (notUnderstood && result.outcome === "unsupported" && !result.intent) return notUnderstood();
      const kind: NoteKind = result.outcome === "unavailable" ? (result.already ? "no-change" : "unavailable") : result.intent ? "unsupported" : "not-understood";
      this.note(result.message, "plain", kind, text);
      return false;
    } catch (error) {
      if (signal.aborted) return false;
      this.note(error instanceof Error ? error.message : "The command could not be read.", "plain", "unsupported", text);
      return false;
    }
  }

  /**
   * A design request: either an act on the directions already on screen, or
   * a new brief for the engine. A brief goes through the provider boundary
   * and the intent schema before a single operation exists, exactly as a
   * command does.
   */
  private async runDesign(text: string, request: DesignRequest, signal: AbortSignal): Promise<boolean> {
    if (request.kind === "session") {
      const design = this.state.design;
      if (!design) {
        this.note(DESIGN_MESSAGES.noSession, "plain", null, text);
        return false;
      }
      if (request.action === "dismiss") {
        this.dismissDesigns();
        return true;
      }
      const proposal = proposalAt(design, request.ordinal);
      if (!proposal) {
        this.note(request.ordinal === null ? DESIGN_MESSAGES.nothingPreviewed : DESIGN_MESSAGES.notThatMany(design.proposals.length), "plain", null, text);
        return false;
      }
      if (request.action === "apply") this.applyDesign(proposal.id);
      else this.previewDesign(proposal.id);
      return true;
    }

    this.set({ command: { ...IDLE, pending: true, text }, limitation: null, receipt: null });
    try {
      const result = await readDesigns(text, this.state.doc.scene, signal);
      if (signal.aborted) return false;
      if (result.outcome === "designs") {
        this.proposeDesigns(result.session);
        return true;
      }
      this.note(result.message, "plain", result.outcome === "none" ? "no-change" : "not-understood", text);
      return false;
    } catch (error) {
      if (signal.aborted) return false;
      this.note(error instanceof Error ? error.message : DESIGN_MESSAGES.noProposals, "plain", "unsupported", text);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // The design agent (Phase 6). Only reached when one is bound.

  /**
   * Agent mode: acts on the directions on screen and Phase 3E commands stay
   * on the deterministic rules; questions, design briefs and words the rules
   * cannot read go to the agent. Its reply is already validated; what it
   * leads to is built by the same engine as everything else, and a failure
   * never touches the document.
   */
  private async runWithAgent(binding: AgentBinding, text: string, signal: AbortSignal): Promise<boolean> {
    const route = preRoute(text);
    if (route.to === "session") return this.runDesign(text, route.request, signal);
    if (route.to === "command") return this.runCommand(text, signal, () => this.askAgent(binding, text, false, true, signal));
    return this.askAgent(binding, text, route.rulesBrief, false, signal);
  }

  private async askAgent(binding: AgentBinding, text: string, rulesBrief: boolean, afterCommand: boolean, signal: AbortSignal): Promise<boolean> {
    // Choosing among pieces re-runs the same question: answer it again from what was read.
    if (this.question?.text === text) return this.answerQuestion(binding, text, this.question.wire);
    this.set({ command: { ...IDLE, pending: true, text }, limitation: null, receipt: null });
    const brief = roomBrief(this.state.doc.scene, binding.evidence, this.state.design?.proposals.map((p) => p.title) ?? []);
    const result = await binding.agent.read({ text, brief }, signal);
    if (signal.aborted) return false;
    if (!result.ok) {
      if (result.failure === "cancelled") {
        this.set({ command: IDLE });
        return false;
      }
      const why = AGENT_MESSAGES.failure[result.failure];
      // A stated threshold is a measurement, never a design count ("80" is not a number of designs).
      const threshold = readThresholdQuestion(text);
      if (threshold) return this.answerQuestion(binding, text, threshold, `${why} ${AGENT_MESSAGES.readByMeasureRules} `);
      if (rulesBrief) {
        const consumed = await this.runDesign(text, { kind: "brief" }, signal);
        if (signal.aborted) return consumed;
        if (consumed) this.note(`${why} ${AGENT_MESSAGES.readByRules}`, "plain", "agent", text);
        return consumed;
      }
      this.note(`${why} ${AGENT_MESSAGES.notAnswered}`, "plain", "agent", text);
      return false;
    }
    const reply = result.reply;
    switch (reply.route) {
      case "design": {
        const outcome = fromIntent(text, reply.design, this.state.doc.scene);
        if (outcome.outcome === "designs") {
          this.proposeDesigns(outcome.session);
          return true;
        }
        this.note(outcome.message, "plain", outcome.outcome === "none" ? "no-change" : "not-understood", text);
        return false;
      }
      case "question":
        this.question = { text, wire: reply.question };
        return this.answerQuestion(binding, text, reply.question);
      case "command":
        // The person's own words go to the Phase 3E rules; the model never rewrites them.
        if (afterCommand) {
          this.note(AGENT_MESSAGES.commandNotRead, "plain", "not-understood", text);
          return false;
        }
        return this.runCommand(text, signal, async () => {
          this.note(AGENT_MESSAGES.commandNotRead, "plain", "not-understood", text);
          return false;
        });
      case "clarify":
        this.note(AGENT_MESSAGES.clarify[reply.clarify], "plain", "agent", text);
        return false;
      case "out_of_scope":
        this.note(AGENT_MESSAGES.outOfScope[reply.outOfScope], "plain", "unsupported", text);
        return false;
    }
  }

  /** A question, answered by Phase 5 on the room as it is shown. Reads, never writes. */
  private answerQuestion(binding: AgentBinding, text: string, wire: QuestionWire, lead = ""): boolean {
    const result = resolveQuestion(wire, this.state.scene, binding.evidence, this.state.selection);
    if (result.kind === "answer") {
      this.note(`${lead}${result.answer.text}`, "plain", "answer", text);
      return false;
    }
    if (result.kind === "clarify") {
      this.note(result.message, "select", "ambiguous", text, result.options);
      return false;
    }
    this.note(result.message, "plain", "unsupported", text);
    return false;
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
  const { doc, proposal, previewing, design } = state;
  // A design being looked at is laid over the document exactly as a
  // command's changes are: the document itself is untouched, so leaving the
  // preview gives back the very same Scene.
  const previewed = design?.previewId ? proposalOf(design, design.previewId) : null;
  if (previewed) return applyOperations(doc.scene, previewed.operations);
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

export const useDesigns = () => useWorkspace((s) => s.design);
export const useCanUndo = () => useWorkspace((s) => canUndo(s.doc));
export const useCanRedo = () => useWorkspace((s) => canRedo(s.doc));
export const useSelectedObject = () =>
  useWorkspace((s) => s.scene.objects.find((o) => o.id === s.selection) ?? null);
