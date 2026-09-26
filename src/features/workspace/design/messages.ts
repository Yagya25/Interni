/** What the person is told about designs, in product language. */
export const MESSAGES = {
  notUnderstood:
    "I couldn’t read that as a design request. Try “give me three furniture layouts”, “make the seating more social”, “give me 3 modern designs” or “make this room feel warmer and more luxurious”.",
  nothingToChange: "This room already reads that way: nothing in it would change.",
  noProposals: "I couldn’t put a design together for this room.",
  finishesOnly: "Finishes are recoloured and the light is reset; what each thing is made of is left as the photograph measured it",
  /** A layout on its own: the room's look is not a layout's business. */
  layoutOnly: "Only furniture moves: finishes and light are left exactly as they are",
  /** Said when the request asked for the furniture to stay put. */
  preserved: "The furniture stays where it is, as asked",
  noSession: "There are no designs on screen. Ask for some first — “give me 3 modern designs”.",
  notThatMany: (count: number) => `There ${count === 1 ? "is one design" : `are ${count} designs`} on screen.`,
  nothingPreviewed: "Preview a design first, or say which one to apply — “apply the second design”.",
  /** Said when a provider's answer fails the intent schema, so the boundary is visible. */
  refused: (reason: string) => `That couldn’t be made into designs: ${reason}.`,
  /** Said when no layout could be made at all. */
  noLayout: (reason: string) => `I couldn’t rearrange this room that way — ${reason}.`,
} as const;
