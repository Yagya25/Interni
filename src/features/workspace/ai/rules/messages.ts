/** What the person is told, in product language rather than parser language. */
export const MESSAGES = {
  notUnderstood:
    "I couldn’t turn that into a change to this room. Try “move the sofa closer to the window”, “rotate the sofa 20 degrees”, “make the sofa darker” or “make the room warmer”.",
  unavailable: "I understand the request, but that edit isn’t available yet.",
  replacementUnavailable: "I can understand the replacement request, but this furniture asset isn’t available yet.",
  whichObject: "Which object should I change? Select it in the room, or name it.",
  whereTo: "Where should it go? Try “closer to the window”, “beside the sofa”, “left 30 cm” or “against the wall”.",
  nothingChanges: "That’s already the case, so there’s nothing to change.",
} as const;
