import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { livingRoom } from "@/demo/livingRoom";
import { compileRoomShell, parseIntermediate } from "@/scene/compile";
import type { Scene } from "@/scene/model/types";
import { preRoute } from "../agent/route";
import { generateProposals } from "./generate";
import { validateDesignIntent, type DesignIntent } from "./intent";
import { readBrief, readDesignRequest } from "./read";

/**
 * Design phrases that already worked, held byte for byte.
 * ================================================================
 *
 * Recorded before Phase 10A changed how "keep the existing layout" is read.
 * Every phrase here must still be routed, read and built exactly as it was:
 * the same route, the same intent, and the same proposals operation for
 * operation — a SHA-256 of the whole result, beside a summary a person can
 * read — in the room from the photograph and in the demonstration room. A
 * change to the reader that moves any of them shows up here first.
 *
 * Phrases whose reading Phase 10A sets out to change ("keep the existing
 * layout", "keep the same layout") are not here; `layout/preserve.test.ts`
 * holds them.
 */

const FIXTURE = new URL("../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);

function realRoom(): Scene {
  const parsed = parseIntermediate(JSON.parse(readFileSync(FIXTURE, "utf8")));
  if (parsed.kind !== "run") throw new Error("the fixture is not a run");
  const compiled = compileRoomShell(parsed.intermediate);
  if (!compiled.ok) throw new Error(compiled.problem.code);
  return compiled.scene;
}

const ROOMS: readonly [string, Scene][] = [
  ["photograph", realRoom()],
  ["demonstration", livingRoom],
];

const PHRASES = [
  // The rule reader's own examples.
  "Give me three furniture layouts",
  "Make the seating more social",
  "Arrange the room around the TV",
  "Make the room more open",
  "Give me 3 modern designs",
  "Show me a Scandinavian version",
  "Make this room feel warmer and more luxurious",
  "A minimal neutral version",
  "Make this room darker and more contemporary",
  "Give me a cozy design",
  "Apply the second design",
  // Styles, atmospheres and counts.
  "Give me a Scandinavian design",
  "a much cozier design",
  "a slightly warmer design",
  "a less warm design",
  "give me a couple of design options",
  "some design ideas",
  "Give the room a modern theme",
  // Layouts, and style words that describe a layout.
  "Create a cozy conversation layout.",
  "Make the room feel less cramped.",
  "Give me a more minimal furniture arrangement.",
  "a slightly less social layout",
  "give me a symmetrical layout with the chairs spread out",
  "Give me a modern cozy design with a conversation layout",
  "make the room feel less cramped and warmer",
  "Rearrange my furniture so it's nicer for talking",
  "Give me three layouts that keep at least 80 cm of circulation",
  // Keeping the furniture where it is, in the words that already read that way.
  "a cozy design but keep the furniture where it is",
  "Give the room a modern theme and keep the furniture where it is",
  "Give the room a modern theme and leave the furniture where it is",
  "Give the room a modern theme and keep the layout as is",
  "Give the room a modern theme and leave the furniture as is",
  "Give me a Scandinavian design and don't move the furniture",
  "keep the layout",
  // "Keep" pointing at a direction on screen is an apply, not a constraint.
  "keep this layout",
  "keep the second layout",
  "keep this design",
  "Make it feel like a Kyoto tea house but keep it bright",
  // Other acts on the directions on screen.
  "preview the third arrangement",
  "apply design 3",
  "exit preview",
  // Questions, and edit commands, which are not briefs.
  "Is there at least 80 cm of circulation space?",
  "Move the sofa 30cm left",
  "make the room warmer",
  "Change the curtains to white",
  "Rotate the sofa 20 degrees",
  "remove the ottoman",
] as const;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function built(scene: Scene, intent: DesignIntent) {
  const result = generateProposals(scene, intent);
  return {
    proposals: result.proposals.map((p) => ({
      id: p.id,
      title: p.title,
      operations: p.operations.length,
      moves: p.operations.filter((op) => op.kind === "move").length,
    })),
    rejected: result.rejected.map((r) => r.id),
    reason: result.reason ?? null,
    sha256: digest({ proposals: result.proposals, rejected: result.rejected, reason: result.reason ?? null }),
  };
}

function reading(text: string) {
  const brief = readBrief(text);
  const checked = brief === null ? null : validateDesignIntent(brief);
  return {
    text,
    request: readDesignRequest(text),
    route: preRoute(text),
    intent: checked === null ? null : checked.ok ? checked.intent : { invalid: checked.reason },
    built: checked?.ok ? Object.fromEntries(ROOMS.map(([name, scene]) => [name, built(scene, checked.intent)])) : null,
  };
}

describe("design phrases that already worked", () => {
  // Every layout phrase is planned in full in both rooms: longer than the default five seconds.
  it("are routed, read and built exactly as they were before Phase 10A", async () => {
    await expect(JSON.stringify(PHRASES.map(reading), null, 2) + "\n").toMatchFileSnapshot("./__fixtures__/phrases.baseline.json");
  }, 60_000);
});
