import { describe, expect, it } from "vitest";
import { livingRoom } from "@/demo/livingRoom";
import { applyOperations, type SceneOperation } from "@/scene/model/operations";
import { findById, roomBounds } from "@/scene/model/queries";
import { generateProposals } from "../generate";
import { validateDesignIntent, type DesignIntent } from "../intent";
import { readBrief, readDesignRequest } from "../read";
import { validateOperations } from "../validate";
import { circulationOf } from "./circulation";
import { passageZones } from "./geometry";
import { spatialRoles } from "./roles";

/**
 * The layout engine's own reasoning: how requests are read, what the
 * provider boundary refuses, what each piece may do, and how a room other
 * than the reconstructed one — the hand-authored demonstration room, with no
 * television, a door, a ceiling pendant and things standing on the sofa and
 * the table — is arranged. The real room is exercised in
 * `realRoomLayout.test.ts`.
 */

const intentOf = (text: string): DesignIntent => {
  const checked = validateDesignIntent(readBrief(text));
  if (!checked.ok) throw new Error(checked.reason);
  return checked.intent;
};
const layoutOf = (text: string) => intentOf(text).layout;

describe("reading a layout request", () => {
  it("tells a layout request from a direct command", () => {
    for (const text of ["Give me three furniture layouts.", "Make the seating more social.", "Arrange the room around the TV.", "Make the room more open.", "Create a cozy conversation layout.", "Make the room feel less cramped.", "Give me a more minimal furniture arrangement."]) {
      expect(readDesignRequest(text), text).toEqual({ kind: "brief" });
    }
    // One change to one piece is a command, whatever words it uses.
    for (const text of ["Move the sofa 30cm left", "Move the sofa 20cm left", "Move the chair", "move the chairs closer together", "turn the armchair to face the tv", "rotate the sofa 90 degrees", "make the room warmer", "make the room brighter", "remove the ottoman"]) {
      expect(readDesignRequest(text), text).toBeNull();
    }
  });

  it("reads what arrangement is asked for, without inventing finishes", () => {
    expect(intentOf("Give me three furniture layouts.")).toMatchObject({ finishes: false, styles: [], variantCount: 3, layout: { styles: [], preserve: false } });
    expect(layoutOf("Make the seating more social.")).toMatchObject({ social: 0.65, styles: [] });
    expect(layoutOf("Arrange the room around the TV.")).toMatchObject({ tvFocus: 0.65, styles: ["TV_FOCUSED"] });
    expect(layoutOf("Make the room more open.")).toMatchObject({ openness: 0.65, styles: ["OPEN"] });
    expect(layoutOf("Make the room feel less cramped.")).toMatchObject({ openness: 0.65 });
    // "Cozy" describes the layout here: seats drawn in. It is not a request to repaint.
    expect(intentOf("Create a cozy conversation layout.")).toMatchObject({ finishes: false, styles: [], layout: { styles: ["CONVERSATION"], social: 0.65, compactness: 0.65 } });
    expect(intentOf("Give me a more minimal furniture arrangement.")).toMatchObject({ finishes: false, layout: { openness: 0.65, symmetry: 0.65 } });
    expect(layoutOf("make the seating much more social")).toMatchObject({ social: 1 });
    expect(layoutOf("a slightly less social layout")).toMatchObject({ social: -0.35 });
    expect(layoutOf("give me a symmetrical layout with the chairs spread out")).toMatchObject({ symmetry: 0.65, separation: 0.65 });
  });

  it("reads a finish style and a layout together when both are asked for", () => {
    expect(intentOf("Give me a modern cozy design with a conversation layout")).toMatchObject({ finishes: true, styles: ["COZY", "MODERN_WARM"], layout: { styles: ["CONVERSATION"] } });
    expect(intentOf("make the room feel less cramped and warmer")).toMatchObject({ finishes: true, warmth: 0.65, layout: { openness: 0.65 } });
    // A plain finish request carries no layout at all.
    expect(intentOf("Give me 3 modern designs")).toMatchObject({ finishes: true, layout: null });
    // Keeping the furniture where it is, while asking for a style.
    expect(intentOf("a cozy design but keep the furniture where it is")).toMatchObject({ finishes: true, styles: ["COZY"], layout: { preserve: true } });
  });

  it("reads an act on layouts already on screen", () => {
    expect(readDesignRequest("apply the second layout")).toEqual({ kind: "session", action: "apply", ordinal: 2 });
    expect(readDesignRequest("preview layout 3")).toEqual({ kind: "session", action: "preview", ordinal: 3 });
    expect(readDesignRequest("preview the third arrangement")).toEqual({ kind: "session", action: "preview", ordinal: 3 });
    // Asking for layouts is never an act on the ones there.
    expect(readDesignRequest("show me three layouts")).toEqual({ kind: "brief" });
  });
});

describe("the provider boundary, for layouts", () => {
  const base = { styles: [], finishes: false };

  it("refuses anything that is not a layout intent, by name", () => {
    expect(validateDesignIntent({ ...base, layout: { styles: ["OPEN"] } })).toMatchObject({ ok: true });
    expect(validateDesignIntent({ ...base, layout: { styles: ["FENG_SHUI"] } })).toMatchObject({ ok: false, reason: expect.stringMatching(/layout\.styles\[0\] must be one of TV_FOCUSED, CONVERSATION, OPEN/) });
    expect(validateDesignIntent({ ...base, layout: { styles: ["OPEN", "OPEN"] } })).toMatchObject({ ok: false, reason: "layout.styles must not repeat" });
    expect(validateDesignIntent({ ...base, layout: { styles: [], social: 3 } })).toMatchObject({ ok: false, reason: "layout.social must be between -1 and 1" });
    expect(validateDesignIntent({ ...base, layout: { styles: [], openness: "lots" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/layout\.openness must be a finite number/) });
    expect(validateDesignIntent({ ...base, layout: { styles: ["OPEN"], preserve: true } })).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot also ask for a layout/) });
    expect(validateDesignIntent({ ...base, layout: "move the sofa" })).toMatchObject({ ok: false, reason: "layout must be an object" });
    // Nothing asked for at all, or finishes asked for and switched off.
    expect(validateDesignIntent({ ...base, layout: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/neither finishes nor a layout/) });
    expect(validateDesignIntent({ styles: ["COZY"], finishes: false, layout: { styles: ["OPEN"] } })).toMatchObject({ ok: false, reason: expect.stringMatching(/finishes is false/) });
  });

  it("gives a provider no way to name a position or an operation", () => {
    // Extra fields are not read: the planner decides what "open" means for this room.
    const checked = validateDesignIntent({ ...base, layout: { styles: ["OPEN"], moves: [{ objectId: "sofa-0", to: [9, 0, 9] }] } });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.intent.layout).not.toHaveProperty("moves");
  });
});

describe("spatial roles", () => {
  it("are derived from the Scene, deterministically, with a reason for each", () => {
    const roles = spatialRoles(livingRoom);
    const role = (id: string) => roles.find((r) => r.id === id)!;
    expect(role("sofa")).toMatchObject({ role: "PRIMARY_SEATING", mobility: "movable" });
    expect(role("armchair")).toMatchObject({ role: "SECONDARY_SEATING", mobility: "movable" });
    expect(role("coffee-table")).toMatchObject({ role: "TABLE", mobility: "movable" });
    expect(role("floor-lamp")).toMatchObject({ role: "LIGHTING", mobility: "movable" });
    expect(role("pendant-lamp")).toMatchObject({ role: "LIGHTING", mobility: "ceiling-mounted" });
    expect(role("artwork")).toMatchObject({ role: "ARTWORK", mobility: "wall-mounted" });
    expect(role("vase")).toMatchObject({ role: "DECOR", mobility: "carried" });
    expect(role("rug")).toMatchObject({ mobility: "anchored" });
    expect(role("door")).toMatchObject({ entity: "opening", role: "OPENING", mobility: "structural" });
    expect(role("wall-north")).toMatchObject({ entity: "surface", role: "STRUCTURAL", mobility: "structural" });
    for (const r of roles) expect(r.reasons.length).toBeGreaterThan(0);
    // The ObjectCategory model is untouched: a role is a layer over it.
    expect(findById(livingRoom.objects, "sofa")!.category).toBe("sofa");
    expect(JSON.stringify(spatialRoles(livingRoom))).toBe(JSON.stringify(roles));
  });
});

describe("circulation", () => {
  it("finds the way in and what stands in front of it, from the room's own openings", () => {
    // A window above the floor is looked through, not walked through.
    expect(passageZones(livingRoom).map((z) => z.opening.id)).toEqual(["door"]);
    const c = circulationOf(livingRoom);
    expect(c.from).toBe("passage");
    expect(c.passages).toEqual([{ openingId: "door", reachable: true, blockedBy: [] }]);
    expect(c.walkableArea).toBeGreaterThan(0);
    expect(c.walkableArea).toBeLessThan(c.openArea);
    const b = roomBounds(livingRoom);
    expect(c.openArea + c.occupiedArea).toBeCloseTo((b.max[0] - b.min[0]) * (b.max[2] - b.min[2]), 1);
    expect(JSON.stringify(circulationOf(livingRoom))).toBe(JSON.stringify(c));
  });
});

describe("layouts for a second, different room", () => {
  it("arranges the demonstration room by its own geometry", () => {
    const result = generateProposals(livingRoom, intentOf("Give me three furniture layouts."));
    expect(result.ok).toBe(true);
    // No television here, so no screen direction: conversation and open ones instead.
    expect(result.proposals.every((p) => p.layout!.style !== "TV_FOCUSED")).toBe(true);
    expect(result.proposals.length).toBeGreaterThanOrEqual(2);
    for (const p of result.proposals) {
      expect(validateOperations(livingRoom, p.operations)).toEqual({ ok: true });
      const after = applyOperations(livingRoom, p.operations);
      // The pendant, the artwork and the rug stay exactly where they were.
      for (const id of ["pendant-lamp", "artwork", "rug"]) expect(findById(after.objects, id)).toBe(findById(livingRoom.objects, id));
    }
  });

  it("says a room has no screen rather than arranging it around one", () => {
    const result = generateProposals(livingRoom, intentOf("Arrange the room around the TV."));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("I couldn’t rearrange this room that way — this room has no television or screen to arrange it around.");
  });

  it("moves what a piece carries with it, and refuses to move it alone", () => {
    const table = findById(livingRoom.objects, "coffee-table")!;
    const vase = findById(livingRoom.objects, "vase")!;
    const shift = (x: number): SceneOperation[] => [
      { kind: "move", objectId: "coffee-table", to: [table.transform.position[0] + x, 0, table.transform.position[2]], rotationY: table.transform.rotation[1] },
      { kind: "move", objectId: "vase", to: [vase.transform.position[0] + x, vase.transform.position[1], vase.transform.position[2]], rotationY: vase.transform.rotation[1] },
    ];
    expect(validateOperations(livingRoom, [shift(0.1)[1]])).toMatchObject({ ok: false, reason: expect.stringMatching(/vase stands on another piece and moves only with it/) });
    // The pendant hangs from the ceiling.
    const pendant = findById(livingRoom.objects, "pendant-lamp")!;
    expect(validateOperations(livingRoom, [{ kind: "move", objectId: "pendant-lamp", to: [0, pendant.transform.position[1], 0], rotationY: 0 }])).toMatchObject({ ok: false, reason: "the pendant stays where it is: it hangs from the ceiling" });
  });

  it("is deterministic", () => {
    const a = generateProposals(livingRoom, intentOf("Give me three furniture layouts."));
    const b = generateProposals(livingRoom, intentOf("Give me three furniture layouts."));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
