import type { AgentFailure, ClarifyReason, OutOfScopeReason } from "./types";

/** Every sentence the design agent's path can show. The model writes none of them. */
export const AGENT_MESSAGES = {
  clarify: {
    "design-or-layout": "Do you want new finishes and light, a new furniture layout, or both? Say which, for example “a calmer layout” or “warmer finishes”.",
    "which-room-part": "Which part of the room do you mean? Name a piece, for example “the sofa”.",
    "too-vague": "Could you say a little more about what you want the room to be like?",
  } satisfies Record<ClarifyReason, string>,
  outOfScope: {
    "new-furniture": "Adding or buying furniture isn’t something this workspace can do: it rearranges and refinishes what the room already has.",
    image: "This workspace doesn’t draw pictures of the room; it changes the 3D room itself, which you can preview.",
    shopping: "Shopping isn’t something this workspace does.",
    "not-about-the-room": "That doesn’t seem to be about this room.",
    "unsupported-question": "That isn’t a question this workspace can measure yet. It can answer sizes, distances, clearance around a piece, free floor, circulation and how wide the way in is.",
  } satisfies Record<OutOfScopeReason, string>,
  commandNotRead:
    "That reads like a direct edit, but only edits the rules can read exactly are carried out — for example “Move the sofa 30 cm left” or “Turn the chair to face the TV”.",
  failure: {
    unavailable: "The design agent couldn’t be reached.",
    timeout: "The design agent took too long to answer.",
    refused: "The design agent declined that request.",
    invalid: "The design agent’s answer couldn’t be read reliably.",
    "rate-limited": "The design agent is busy; try again in a moment.",
    cancelled: "Cancelled.",
  } satisfies Record<AgentFailure, string>,
  readByRules: "Read with the design rules instead.",
  readByMeasureRules: "Read as a measurement question instead:",
  notAnswered: "This couldn’t be answered without it.",
  whichOne: (words: string) => `“${words}” fits more than one piece. Which one do you mean?`,
  cannotMeasure: (words: string) => `“${words}” isn’t something that can be measured to here; name a piece of furniture or the doorway.`,
  noAnswer: (reason: string) => `That couldn’t be measured: ${reason}.`,

  // Phase 9: the directions on screen, measured by the engine.
  directions: {
    none: "There are no design directions on screen to measure. Ask for some first — “give me three furniture layouts”.",
    notThatMany: (count: number) => `There ${count === 1 ? "is one direction" : `are ${count} directions`} on screen.`,
    /** Before Phase 5's own answer, for one direction. */
    one: (ordinal: number, title: string) => `${ordinal}. ${title}, laid over the room as its preview shows it: `,
    /** Before the values, for several. */
    each: (label: string) => `${label}, with each direction laid over the room as its preview shows it:`,
    now: "now",
    unmeasured: "couldn’t be measured",
    unreachable: "a seat can’t be reached from the way in",
    verdict: { yes: "yes", no: "no", "too-close-to-call": "too close to call" },
    narrowest: "narrowest",
    /** No direction stands apart from every other: said instead of a most or a least. */
    indistinct: (topic: string) => `No one direction can be meaningfully told apart from all the others on ${topic}: the differences are within the steps the values are known to.`,
    others: "the others cannot be meaningfully told apart.",
    checked: "Measured on each new direction:",
    notChecked: (message: string) => `Not checked — ${message}`,
    /** A check whose piece fits several: named, since a check offers nothing to click. */
    notCheckedWhich: (labels: readonly string[]) => `Not checked — more than one piece fits (${labels.join(", ")}): name one to check it.`,
    uncalibrated: "Not calibrated: every length shares one unknown scale error.",
    authored: "This room was authored, not measured.",
  },
};
