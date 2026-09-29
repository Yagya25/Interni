import type { Scene } from "@/scene/model/types";
import { analyseScene, type DesignAnalysis } from "./analysis";
import { generateProposals } from "./generate";
import { validateDesignIntent, type DesignIntent } from "./intent";
import { MESSAGES } from "./messages";
import { withStatus, type DesignProposal, type RejectedProposal } from "./proposal";
import { designRules, type DesignIntentProvider } from "./read";

/**
 * A set of directions on screen.
 * ================================================================
 *
 *   text → DesignIntentProvider → validateDesignIntent → DesignIntent
 *        → analyseScene → generateProposals → DesignProposal[]
 *        → preview → apply → the workspace's history
 *
 * The session is what the workspace holds between asking and choosing: the
 * request, what it was read as, the room it was read against, the
 * proposals, and which one is being looked at. Nothing here touches the
 * document — previewing lays a proposal over the renderer's scene, and
 * applying hands its operations to the store, which commits them as one
 * step exactly as it commits a command.
 */

export interface DesignSession {
  /** The words asked, kept so the directions can be read on their own. */
  request: string;
  intent: DesignIntent;
  analysis: DesignAnalysis;
  proposals: readonly DesignProposal[];
  /** Directions that were generated but would not pass the validator. */
  rejected: readonly RejectedProposal[];
  /** The one laid over the room, if any. */
  previewId: string | null;
  /** The one applied to the document, if any. */
  appliedId: string | null;
  /**
   * What was measured on each direction, when the request asked (Phase 9).
   * Derived metadata beside the proposals, never part of them: a checked
   * proposal is the same plan, operation for operation, as an unchecked one.
   */
  checks?: readonly DirectionCheck[];
}

/** One thing measured on every direction, by Phase 5, with the direction laid over the room as Preview lays it. */
export interface DirectionCheck {
  /** What was measured, in the person's terms: "Free floor", "At least 80 cm to every seat". */
  label: string;
  /** The room the directions were laid over. The lines describe that room, and only while it is the room. */
  measuredOn: Scene;
  /** One short line per direction. */
  results: readonly DirectionCheckResult[];
}

export interface DirectionCheckResult {
  proposalId: string;
  /** "Free floor ≈ 18 m²", "At least 80 cm to every seat: no (narrowest ≈ 0.55 m)". */
  text: string;
  /** Phase 5's verdict, for a check that asks for one. */
  verdict: "yes" | "no" | "too-close-to-call" | null;
}

export type DesignOutcome =
  | { outcome: "designs"; session: DesignSession }
  /** Read, but nothing could be offered for this room. */
  | { outcome: "none"; message: string }
  /** The provider's answer did not survive the intent schema. */
  | { outcome: "unsupported"; message: string };

/** One request, from words to validated directions. */
export async function readDesigns(
  request: string,
  scene: Scene,
  signal: AbortSignal,
  provider: DesignIntentProvider = designRules,
): Promise<DesignOutcome> {
  const read = await provider.read(request, signal);
  if (signal.aborted) throw new Error("Cancelled");
  if (read === null || read === undefined) return { outcome: "unsupported", message: MESSAGES.notUnderstood };
  const checked = validateDesignIntent(read);
  if (!checked.ok) return { outcome: "unsupported", message: MESSAGES.refused(checked.reason) };
  return fromIntent(request, checked.intent, scene);
}

/** The same, from an intent already checked: the path a model's answer takes too. */
export function fromIntent(request: string, intent: DesignIntent, scene: Scene): DesignOutcome {
  const analysis = analyseScene(scene);
  const generated = generateProposals(scene, intent, analysis);
  if (!generated.ok) return { outcome: "none", message: generated.reason ?? MESSAGES.noProposals };
  return {
    outcome: "designs",
    session: {
      request,
      intent,
      analysis: generated.analysis,
      proposals: generated.proposals,
      rejected: generated.rejected,
      previewId: null,
      appliedId: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading a session

export const proposalOf = (session: DesignSession, id: string | null) =>
  session.proposals.find((proposal) => proposal.id === id) ?? null;

/** The proposal an ordinal points at: 1-based, with −1 for "the last one". */
export function proposalAt(session: DesignSession, ordinal: number | null): DesignProposal | null {
  if (ordinal === null) return proposalOf(session, session.previewId);
  if (ordinal === -1) return session.proposals[session.proposals.length - 1] ?? null;
  return session.proposals[ordinal - 1] ?? null;
}

/**
 * The session with one proposal previewed, or none. Status is kept on the
 * proposals themselves, so what the cards show and what the renderer draws
 * cannot drift apart.
 */
export function previewing(session: DesignSession, id: string | null): DesignSession {
  if (session.previewId === id) return session;
  return {
    ...session,
    previewId: id,
    proposals: session.proposals.map((proposal) =>
      proposal.status === "applied" ? proposal : withStatus(proposal, proposal.id === id ? "preview" : "draft"),
    ),
  };
}

/**
 * The session with one proposal recorded as applied, the preview let go and
 * the directions that were not taken marked as such. They stay on screen and
 * can still be previewed or applied — choosing one is not deleting the rest.
 */
export function applied(session: DesignSession, id: string): DesignSession {
  return {
    ...session,
    previewId: null,
    appliedId: id,
    proposals: session.proposals.map((proposal) =>
      withStatus(proposal, proposal.id === id ? "applied" : "rejected"),
    ),
  };
}
