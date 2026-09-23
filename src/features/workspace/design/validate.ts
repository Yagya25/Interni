import { ALLOWED_CLASSES } from "@/scene/compile/materials";
import { applyOperations, type SceneOperation } from "@/scene/model/operations";
import { findById } from "@/scene/model/queries";
import type { Scene } from "@/scene/model/types";
import { footprintOf, insideRoom } from "../ai/rules/spatial";
import { SCALE_LIMITS } from "../ai/command";

/**
 * Nothing is shown that the room cannot take.
 * ================================================================
 *
 * A proposal is generated, then checked against the Scene it was generated
 * for, operation by operation: every id must exist and be the right kind of
 * thing, every finish must be one that slot can take, every light value has
 * to be inside its range, and no operation may leave the room structurally
 * invalid — a piece outside the footprint, a surface without a material, a
 * light without a fixture.
 *
 * The check is deliberately wider than what the deterministic generator can
 * produce today. It is the boundary a future generator — or a model asked
 * for a bolder plan — has to pass, so it verifies transforms too, and the
 * generator's own restraint is not what keeps the room valid.
 */

export type ProposalCheck = { ok: true } | { ok: false; reason: string };

/** Light values a proposal may ask for; outside these a room stops being a room. */
const KELVIN = [1800, 6500] as const;
const OUTPUT = [0, 3] as const;

export function validateOperations(scene: Scene, operations: readonly SceneOperation[]): ProposalCheck {
  if (operations.length === 0) return { ok: false, reason: "the proposal would change nothing" };
  try {
    let working = scene;
    for (const operation of operations) {
      check(working, operation);
      working = applyOperations(working, [operation]);
    }
    const placed = new Set(operations.flatMap((op) => (op.kind === "move" || op.kind === "scale" ? [op.objectId] : [])));
    structural(scene, working, placed);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function check(scene: Scene, operation: SceneOperation) {
  switch (operation.kind) {
    case "restyle": {
      const object = findById(scene.objects, operation.objectId);
      if (!object) throw new Error(`there is no object ${operation.objectId} in this room`);
      if (!(operation.slot in object.materials)) throw new Error(`the ${object.label.toLowerCase()} has no ${operation.slot}`);
      material(operation.to, findById(scene.materials, object.materials[operation.slot]), `${object.category}.${operation.slot}`, `a ${object.label.toLowerCase()}’s ${operation.slot}`);
      return;
    }

    case "resurface": {
      const surface = findById(scene.surfaces, operation.surfaceId);
      if (!surface) throw new Error(`there is no surface ${operation.surfaceId} in this room`);
      material(operation.to, findById(scene.materials, surface.materialId), `surface.${surface.kind}`, `the ${surface.label.toLowerCase()}`);
      return;
    }

    case "relight": {
      const light = findById(scene.lights, operation.lightId);
      if (!light) throw new Error(`there is no light ${operation.lightId} in this room`);
      const { timeOfDay, colorTemperature, intensity, on } = operation.to;
      if (timeOfDay !== undefined) {
        if (light.kind !== "daylight") throw new Error(`${light.id} is not daylight, so it has no hour`);
        if (timeOfDay !== "auto" && (!Number.isFinite(timeOfDay) || timeOfDay < 0 || timeOfDay > 1)) throw new Error("an hour runs from 0 (midday) to 1 (night)");
      }
      if (colorTemperature !== undefined || intensity !== undefined || on !== undefined) {
        if (light.kind !== "artificial") throw new Error(`${light.id} is not a lamp`);
        if (!findById(scene.objects, light.fixtureId)) throw new Error(`the light ${light.id} has no fixture in this room`);
      }
      if (colorTemperature !== undefined && (!Number.isFinite(colorTemperature) || colorTemperature < KELVIN[0] || colorTemperature > KELVIN[1])) {
        throw new Error(`a bulb runs between ${KELVIN[0]} K and ${KELVIN[1]} K`);
      }
      if (intensity !== undefined && (!Number.isFinite(intensity) || intensity < OUTPUT[0] || intensity > OUTPUT[1])) {
        throw new Error(`a lamp's output runs between ${OUTPUT[0]} and ${OUTPUT[1]}`);
      }
      return;
    }

    case "move": {
      const object = findById(scene.objects, operation.objectId);
      if (!object) throw new Error(`there is no object ${operation.objectId} in this room`);
      if (!operation.to.every(Number.isFinite) || !Number.isFinite(operation.rotationY)) throw new Error(`the ${object.label.toLowerCase()} would be moved nowhere finite`);
      if (!insideRoom(scene, footprintOf(object, operation.to, operation.rotationY))) throw new Error(`the ${object.label.toLowerCase()} would end up outside the room`);
      if (object.support.kind === "wall") throw new Error(`the ${object.label.toLowerCase()} hangs on a wall; a design proposal does not take it off`);
      return;
    }

    case "scale": {
      const object = findById(scene.objects, operation.objectId);
      if (!object) throw new Error(`there is no object ${operation.objectId} in this room`);
      const [lo, hi] = SCALE_LIMITS.total;
      if (!operation.to.every((s) => Number.isFinite(s) && s >= lo && s <= hi)) throw new Error(`the ${object.label.toLowerCase()} would be resized past what this editor allows`);
      return;
    }

    // Structural pieces of a reconstructed room are not a design's to invent
    // or destroy: a proposal restyles and relights what the photograph found.
    case "add":
      throw new Error("a design proposal cannot add furniture: there is no asset library behind it");
    case "remove":
      throw new Error("a design proposal cannot take furniture out of the room");
    case "replace":
      throw new Error("a design proposal cannot swap one piece for another");
  }
}

/**
 * A finish the room can take. The allowed classes are the compiler's own
 * (`ALLOWED_CLASSES`), and they are enforced only when a proposal *changes*
 * what something is made of: keeping the class the photograph measured is
 * always allowed, even where the compiler's stand-in is of a class the
 * table would not have chosen.
 */
function material(
  to: { id: string; class: string; color: string; roughness: number; metalness: number },
  from: { class: string } | undefined,
  key: string,
  what: string,
) {
  if (!/^#[0-9a-f]{6}$/i.test(to.color)) throw new Error(`${to.color} is not a colour`);
  if (!to.id.trim()) throw new Error("a finish needs an id");
  if (!Number.isFinite(to.roughness) || to.roughness < 0 || to.roughness > 1) throw new Error("roughness runs from 0 to 1");
  if (!Number.isFinite(to.metalness) || to.metalness < 0 || to.metalness > 1) throw new Error("metalness runs from 0 to 1");
  if (from && to.class === from.class) return;
  const classes = ALLOWED_CLASSES[key];
  if (classes && !classes.includes(to.class as (typeof classes)[number])) {
    throw new Error(`${what} can be ${classes.join(" or ")}, not ${to.class}`);
  }
}

/**
 * What has to still be true of the room once the whole plan has run. Only
 * the pieces the plan actually placed are re-checked against the room's
 * plan: a proposal answers for what it did, not for how the compiler read
 * the photograph.
 */
function structural(before: Scene, after: Scene, placed: ReadonlySet<string>) {
  if (after.objects.length !== before.objects.length) throw new Error("a design proposal cannot change what is in the room");
  if (after.surfaces.length !== before.surfaces.length) throw new Error("a design proposal cannot change the room's surfaces");
  if (after.openings.length !== before.openings.length) throw new Error("a design proposal cannot change the room's openings");
  if (after.lights.length !== before.lights.length) throw new Error("a design proposal cannot add or remove lights");
  for (const surface of after.surfaces) {
    if (!findById(after.materials, surface.materialId)) throw new Error(`the ${surface.label.toLowerCase()} would be left without a finish`);
  }
  for (const object of after.objects) {
    for (const [slot, id] of Object.entries(object.materials)) {
      if (!findById(after.materials, id)) throw new Error(`the ${object.label.toLowerCase()}’s ${slot} would be left without a finish`);
    }
    if (placed.has(object.id) && !insideRoom(after, footprintOf(object))) throw new Error(`the ${object.label.toLowerCase()} would end up outside the room`);
  }
  for (const light of after.lights) {
    if (light.kind === "artificial" && !findById(after.objects, light.fixtureId)) throw new Error(`the ${light.label.toLowerCase()} would be left without a fixture`);
  }
}
